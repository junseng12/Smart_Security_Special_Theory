// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SmartCityEscrowV2
 * @notice Perun AssetHolder 패턴 참조 — 사용자(buyer)가 직접 USDC를 예치
 *
 * ─── 올바른 자금 흐름 ──────────────────────────────────────────────────────────
 *
 *  [사용자] --MetaMask approve + buyerDeposit()--> [에스크로 컨트랙트]
 *       │  상태: Deposited
 *       │
 *       ▼  (세션 종료 후 operator가 호출)
 *  settleAndRelease(escrowId, fareAmount)
 *       │  요금(fareAmount) → seller(operator)
 *       │  잔금(deposit - fare) → buyer(사용자)
 *       │  상태: Released
 *       │
 *       └── [문제 발생 시] registerRefundIssue() → refundToBuyer()
 *               전액 → buyer 환불
 *               상태: Refunded
 *
 * ─── Perun AssetHolderERC20 참조 ──────────────────────────────────────────────
 *  - depositEnact: token.transferFrom(msg.sender, address(this), amount)
 *  - withdrawEnact: token.transfer(receiver, amount)
 *  → buyerDeposit() = depositEnact 방식 그대로 적용
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SmartCityEscrowV2 is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    enum EscrowState { None, Deposited, RefundIssue, Released, Refunded }

    enum IssueType {
        UnlockFailure, DeviceFault, WrongCharge,
        SensorFailure, ServiceOutage, Other
    }

    struct EscrowRecord {
        address buyer;          // 사용자 — 예치자 & 환불 수신자
        address seller;         // 서비스 제공자 — 요금 수신자
        uint256 depositAmount;  // 사용자가 예치한 총액 (6 decimals)
        uint256 fareAmount;     // 실제 청구 요금 (settleAndRelease 시 설정)
        uint256 holdDeadline;   // 이 시각 이후 settleAndRelease 가능
        EscrowState state;
    }

    struct IssueRecord {
        IssueType issueType;
        string description;
        uint256 registeredAt;
    }

    IERC20 public immutable usdc;
    mapping(bytes32 => EscrowRecord) public escrows;
    mapping(bytes32 => IssueRecord)  public issues;

    // ── Events ────────────────────────────────────────────────────────────────
    event BuyerDeposited(bytes32 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount, uint256 holdDeadline);
    event SettledAndReleased(bytes32 indexed escrowId, address indexed seller, uint256 fare, address indexed buyer, uint256 refund);
    event RefundIssueRegistered(bytes32 indexed escrowId, IssueType issueType, string description);
    event RefundedToBuyer(bytes32 indexed escrowId, address indexed buyer, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────
    error EscrowAlreadyExists(bytes32 escrowId);
    error EscrowNotFound(bytes32 escrowId);
    error InvalidState(EscrowState current, EscrowState required);
    error HoldDeadlineNotReached(uint256 deadline, uint256 now_);
    error FareExceedsDeposit(uint256 fare, uint256 deposit);
    error ZeroAmount();
    error ZeroAddress();
    error InvalidHoldDeadline();

    constructor(address _usdc, address _operator) {
        if (_usdc == address(0) || _operator == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, _operator);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. buyerDeposit — 사용자가 직접 USDC 예치 (Perun AssetHolder depositEnact 방식)
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * @notice 사용자가 MetaMask로 직접 호출. 세션 시작 시 보증금 예치.
     * @dev 호출 전: usdc.approve(escrowContractAddress, amount) 필요
     * @param escrowId     keccak256(sessionId) — 백엔드와 동일하게 생성
     * @param seller       서비스 제공자 주소 (요금 수신)
     * @param amount       예치할 USDC 금액 (6 decimals, e.g. 3 USDC = 3_000_000)
     * @param holdDeadline 정산 가능 시각 (Unix timestamp)
     */
    function buyerDeposit(
        bytes32 escrowId,
        address seller,
        uint256 amount,
        uint256 holdDeadline
    ) external nonReentrant {
        if (escrows[escrowId].state != EscrowState.None) revert EscrowAlreadyExists(escrowId);
        if (amount == 0)                    revert ZeroAmount();
        if (seller == address(0))           revert ZeroAddress();
        if (holdDeadline <= block.timestamp) revert InvalidHoldDeadline();

        // Perun AssetHolderERC20 depositEnact 방식 그대로
        // msg.sender(사용자)의 USDC → 컨트랙트
        escrows[escrowId] = EscrowRecord({
            buyer:         msg.sender,
            seller:        seller,
            depositAmount: amount,
            fareAmount:    0,
            holdDeadline:  holdDeadline,
            state:         EscrowState.Deposited
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit BuyerDeposited(escrowId, msg.sender, seller, amount, holdDeadline);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. settleAndRelease — 세션 종료 후 요금/잔금 분리 정산
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * @notice operator가 세션 종료 후 호출. 요금→seller, 잔금→buyer 동시 지급.
     * @param escrowId    대상 Escrow ID
     * @param fareAmount  실제 청구 요금 (≤ depositAmount)
     */
    function settleAndRelease(
        bytes32 escrowId,
        uint256 fareAmount
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None)       revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.Deposited)  revert InvalidState(rec.state, EscrowState.Deposited);
        if (block.timestamp < rec.holdDeadline)  revert HoldDeadlineNotReached(rec.holdDeadline, block.timestamp);
        if (fareAmount > rec.depositAmount)       revert FareExceedsDeposit(fareAmount, rec.depositAmount);

        uint256 deposit = rec.depositAmount;
        uint256 refund  = deposit - fareAmount;
        address seller  = rec.seller;
        address buyer   = rec.buyer;

        // Effects before Interactions
        rec.state      = EscrowState.Released;
        rec.fareAmount = fareAmount;
        rec.depositAmount = 0;

        // 요금 → seller (Perun withdrawEnact 방식)
        if (fareAmount > 0) usdc.safeTransfer(seller, fareAmount);
        // 잔금 → buyer
        if (refund > 0)     usdc.safeTransfer(buyer, refund);

        emit SettledAndReleased(escrowId, seller, fareAmount, buyer, refund);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. registerRefundIssue — 문제 등록
    // ─────────────────────────────────────────────────────────────────────────
    function registerRefundIssue(
        bytes32 escrowId,
        IssueType issueType,
        string calldata description
    ) external onlyRole(OPERATOR_ROLE) {
        EscrowRecord storage rec = escrows[escrowId];
        if (rec.state == EscrowState.None)      revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.Deposited) revert InvalidState(rec.state, EscrowState.Deposited);

        rec.state = EscrowState.RefundIssue;
        issues[escrowId] = IssueRecord({ issueType: issueType, description: description, registeredAt: block.timestamp });

        emit RefundIssueRegistered(escrowId, issueType, description);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. refundToBuyer — 문제 승인 시 전액 환불
    // ─────────────────────────────────────────────────────────────────────────
    function refundToBuyer(bytes32 escrowId) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];
        if (rec.state == EscrowState.None)         revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.RefundIssue)  revert InvalidState(rec.state, EscrowState.RefundIssue);

        uint256 amount = rec.depositAmount;
        address buyer  = rec.buyer;

        rec.state         = EscrowState.Refunded;
        rec.depositAmount = 0;

        usdc.safeTransfer(buyer, amount);
        emit RefundedToBuyer(escrowId, buyer, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. getEscrowStatus — 상태 조회
    // ─────────────────────────────────────────────────────────────────────────
    function getEscrowStatus(bytes32 escrowId) external view returns (
        EscrowState state,
        uint256 depositAmount,
        uint256 fareAmount,
        address buyer,
        address seller,
        uint256 holdDeadline,
        bool isDeadlinePassed
    ) {
        EscrowRecord storage rec = escrows[escrowId];
        return (
            rec.state,
            rec.depositAmount,
            rec.fareAmount,
            rec.buyer,
            rec.seller,
            rec.holdDeadline,
            block.timestamp >= rec.holdDeadline
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. emergencyCancel — 관리자 긴급 취소
    // ─────────────────────────────────────────────────────────────────────────
    function emergencyCancel(bytes32 escrowId) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];
        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        require(
            rec.state == EscrowState.Deposited || rec.state == EscrowState.RefundIssue,
            "Cannot cancel: already settled"
        );

        uint256 amount = rec.depositAmount;
        address buyer  = rec.buyer;

        rec.state         = EscrowState.Refunded;
        rec.depositAmount = 0;

        usdc.safeTransfer(buyer, amount);
        emit RefundedToBuyer(escrowId, buyer, amount);
    }
}
