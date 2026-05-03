// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SmartCityEscrow
 * @notice Perun 정산 완료 후 자금을 일시 잠금(Hold & Verify)하는 에스크로 컨트랙트
 *
 * ─── 흐름 ───────────────────────────────────────────────────────────────────
 *
 *  Perun Settlement
 *       │
 *       ▼
 *  lockFunds(sessionId, buyer, merchant, amount)   ← 운영자 호출
 *       │  24h Hold & Verify
 *       ├──────────────────────────────────────────────────────────────────────
 *       │  4a. Issue 확인 (환불 케이스 APPROVED)
 *       │        refundToBuyer(sessionId)           ← 운영자 호출
 *       │        → buyer 주소로 USDC 전송
 *       │
 *       └──────────────────────────────────────────────────────────────────────
 *          4b. No Issue (24h 경과, 이슈 없음)
 *                releaseToMerchant(sessionId)       ← 운영자 호출
 *                → merchant 주소로 USDC 전송
 *
 * ─── 보안 ───────────────────────────────────────────────────────────────────
 *  - 오직 OPERATOR_ROLE만 lock/release/refund 가능
 *  - Buyer는 24h 이후 이슈 없는 경우 직접 reclaimExpired 불가 (운영자 통해 처리)
 *  - ReentrancyGuard 적용
 *  - 비상 탈출(emergencyWithdraw): owner만 가능
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SmartCityEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Roles ────────────────────────────────────────────────────────────────
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ── 상수 ─────────────────────────────────────────────────────────────────
    uint256 public constant HOLD_PERIOD = 24 hours;

    // ── Escrow 상태 ───────────────────────────────────────────────────────────
    enum EscrowState {
        None,       // 0: 존재하지 않음
        Locked,     // 1: 잠금 완료, Hold 기간 진행 중
        Refunded,   // 2: Buyer에게 환불 완료 (4a)
        Released,   // 3: Merchant에게 지급 완료 (4b)
        Cancelled   // 4: 운영자 비상 취소
    }

    // ── Escrow 레코드 ─────────────────────────────────────────────────────────
    struct EscrowRecord {
        address buyer;
        address merchant;
        uint256 amount;       // USDC (6 decimals)
        uint256 lockedAt;
        uint256 releaseAfter; // lockedAt + HOLD_PERIOD
        EscrowState state;
    }

    // ── Storage ───────────────────────────────────────────────────────────────
    IERC20 public immutable usdc;
    mapping(bytes32 => EscrowRecord) public escrows; // sessionId → record

    // ── Events ────────────────────────────────────────────────────────────────
    event FundsLocked(
        bytes32 indexed sessionId,
        address indexed buyer,
        address indexed merchant,
        uint256 amount,
        uint256 releaseAfter
    );
    event BuyerRefunded(
        bytes32 indexed sessionId,
        address indexed buyer,
        uint256 amount
    );
    event MerchantPaid(
        bytes32 indexed sessionId,
        address indexed merchant,
        uint256 amount
    );
    event EscrowCancelled(bytes32 indexed sessionId, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────
    error EscrowAlreadyExists(bytes32 sessionId);
    error EscrowNotFound(bytes32 sessionId);
    error EscrowNotLocked(bytes32 sessionId, EscrowState current);
    error HoldPeriodNotExpired(bytes32 sessionId, uint256 releaseAfter, uint256 now_);
    error ZeroAmount();
    error ZeroAddress();

    // ── Constructor ───────────────────────────────────────────────────────────
    constructor(address _usdc, address _operator) {
        if (_usdc == address(0) || _operator == address(0)) revert ZeroAddress();

        usdc = IERC20(_usdc);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, _operator);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }

    // ── 1. 자금 잠금 (Perun 정산 완료 후 운영자 호출) ────────────────────────
    /**
     * @notice Perun 정산 완료된 운영자 수령분을 에스크로에 잠금
     * @param sessionId  세션 ID (bytes32)
     * @param buyer      사용자 지갑 주소 (환불 수신자)
     * @param merchant   운영자/판매자 지갑 주소
     * @param amount     잠글 USDC 금액 (6 decimals)
     *
     * 호출 전: operator가 approve(escrowAddress, amount)를 USDC 컨트랙트에 먼저 실행해야 함
     */
    function lockFunds(
        bytes32 sessionId,
        address buyer,
        address merchant,
        uint256 amount
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (escrows[sessionId].state != EscrowState.None)
            revert EscrowAlreadyExists(sessionId);
        if (amount == 0)            revert ZeroAmount();
        if (buyer == address(0))    revert ZeroAddress();
        if (merchant == address(0)) revert ZeroAddress();

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        uint256 releaseAfter = block.timestamp + HOLD_PERIOD;

        escrows[sessionId] = EscrowRecord({
            buyer:        buyer,
            merchant:     merchant,
            amount:       amount,
            lockedAt:     block.timestamp,
            releaseAfter: releaseAfter,
            state:        EscrowState.Locked
        });

        emit FundsLocked(sessionId, buyer, merchant, amount, releaseAfter);
    }

    // ── 4a. Buyer 환불 (Issue 확인, Hold 중이라도 즉시 가능) ─────────────────
    /**
     * @notice 환불 케이스 승인 시 즉시 buyer에게 USDC 반환
     * @param sessionId  대상 세션 ID
     *
     * Hold 기간 내에도 운영자가 승인하면 바로 환불 처리 가능
     */
    function refundToBuyer(
        bytes32 sessionId
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[sessionId];

        if (rec.state == EscrowState.None)    revert EscrowNotFound(sessionId);
        if (rec.state != EscrowState.Locked)  revert EscrowNotLocked(sessionId, rec.state);

        uint256 amount  = rec.amount;
        address buyer   = rec.buyer;

        rec.state  = EscrowState.Refunded;
        rec.amount = 0;

        usdc.safeTransfer(buyer, amount);
        emit BuyerRefunded(sessionId, buyer, amount);
    }

    // ── 4b. Merchant 지급 (No Issue, Hold 기간 만료 후) ──────────────────────
    /**
     * @notice 24h Hold 만료 후 이슈 없으면 merchant에게 USDC 지급
     * @param sessionId  대상 세션 ID
     */
    function releaseToMerchant(
        bytes32 sessionId
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[sessionId];

        if (rec.state == EscrowState.None)   revert EscrowNotFound(sessionId);
        if (rec.state != EscrowState.Locked) revert EscrowNotLocked(sessionId, rec.state);
        if (block.timestamp < rec.releaseAfter)
            revert HoldPeriodNotExpired(sessionId, rec.releaseAfter, block.timestamp);

        uint256 amount   = rec.amount;
        address merchant = rec.merchant;

        rec.state  = EscrowState.Released;
        rec.amount = 0;

        usdc.safeTransfer(merchant, amount);
        emit MerchantPaid(sessionId, merchant, amount);
    }

    // ── 비상 취소 (운영자) ────────────────────────────────────────────────────
    /**
     * @notice 운영자가 에스크로를 취소하고 buyer에게 전액 환불
     */
    function cancelEscrow(
        bytes32 sessionId
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[sessionId];

        if (rec.state == EscrowState.None)   revert EscrowNotFound(sessionId);
        if (rec.state != EscrowState.Locked) revert EscrowNotLocked(sessionId, rec.state);

        uint256 amount = rec.amount;
        address buyer  = rec.buyer;

        rec.state  = EscrowState.Cancelled;
        rec.amount = 0;

        usdc.safeTransfer(buyer, amount);
        emit EscrowCancelled(sessionId, amount);
    }

    // ── View: 에스크로 상태 조회 ──────────────────────────────────────────────
    function getEscrowRecord(
        bytes32 sessionId
    ) external view returns (
        EscrowState state,
        uint256 amount,
        address buyer,
        address merchant,
        uint256 lockedAt,
        uint256 releaseAfter
    ) {
        EscrowRecord storage rec = escrows[sessionId];
        return (rec.state, rec.amount, rec.buyer, rec.merchant, rec.lockedAt, rec.releaseAfter);
    }

    /**
     * @notice Hold 기간이 만료됐는지 확인
     */
    function isHoldExpired(bytes32 sessionId) external view returns (bool) {
        return block.timestamp >= escrows[sessionId].releaseAfter;
    }
}
