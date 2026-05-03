// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SmartCityEscrow
 * @notice Perun 정산 완료 후 Seller 지급 예정 금액을 Hold → 문제 없으면 Seller Payment, 문제 있으면 Buyer Refund
 *
 * ─── 흐름 ───────────────────────────────────────────────────────────────────
 *
 *  Perun Settlement 완료
 *       │
 *       ▼
 *  createEscrow(escrowId, buyer, seller, amount, holdDeadline)
 *       │  상태: Held
 *       │
 *       ├── [문제 발생] registerRefundIssue(escrowId, issueType, description)
 *       │       │  상태: RefundIssue
 *       │       └── refundToBuyer(escrowId)
 *       │               상태: Refunded → buyer 지갑으로 즉시 전송 (Push)
 *       │
 *       └── [문제 없음 + holdDeadline 경과]
 *               releaseToSeller(escrowId)
 *               상태: Released → seller 지갑으로 즉시 전송 (Push)
 *
 * ─── 설계 원칙 ───────────────────────────────────────────────────────────────
 *  - Push 방식: releaseToSeller / refundToBuyer 호출 시 즉시 송금 (withdraw 불필요)
 *  - OPERATOR_ROLE만 createEscrow / registerRefundIssue / release / refund 가능
 *  - ReentrancyGuard + Checks-Effects-Interactions 패턴 적용
 *  - 모든 상태 변화에 Event 발행 → 백엔드 동기화
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SmartCityEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Roles ─────────────────────────────────────────────────────────────────
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ── Escrow 상태 ───────────────────────────────────────────────────────────
    enum EscrowState {
        None,           // 존재하지 않음
        Held,           // 잠금 완료, Hold 기간 진행 중
        RefundIssue,    // 문제 등록됨, 환불 검토 중
        Released,       // Seller에게 지급 완료 (4b)
        Refunded        // Buyer에게 환불 완료 (4a)
    }

    // ── Issue 유형 ────────────────────────────────────────────────────────────
    enum IssueType {
        UnlockFailure,      // 잠금 해제 실패
        DeviceFault,        // 기기 결함
        WrongCharge,        // 잘못된 요금 청구
        SensorFailure,      // 센서 오류 (미반납 감지 실패)
        ServiceOutage,      // 서비스 장애
        Other               // 기타
    }

    // ── Escrow 레코드 ─────────────────────────────────────────────────────────
    struct EscrowRecord {
        address buyer;          // 사용자 지갑 (환불 수신자)
        address seller;         // 운영자/판매자 지갑 (정상 지급 수신자)
        uint256 amount;         // Hold된 USDC 금액 (6 decimals)
        uint256 holdDeadline;   // 이 시각 이후에만 releaseToSeller 가능
        EscrowState state;
    }

    // ── Issue 레코드 ──────────────────────────────────────────────────────────
    struct IssueRecord {
        IssueType issueType;
        string description;
        uint256 registeredAt;
    }

    // ── Storage ───────────────────────────────────────────────────────────────
    IERC20 public immutable usdc;

    mapping(bytes32 => EscrowRecord) public escrows;    // escrowId → EscrowRecord
    mapping(bytes32 => IssueRecord)  public issues;     // escrowId → IssueRecord (최신 1건)

    // ── Events (백엔드 동기화용) ───────────────────────────────────────────────
    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        uint256 amount,
        uint256 holdDeadline
    );

    event RefundIssueRegistered(
        bytes32 indexed escrowId,
        IssueType issueType,
        string description,
        uint256 registeredAt
    );

    event ReleasedToSeller(
        bytes32 indexed escrowId,
        address indexed seller,
        uint256 amount
    );

    event RefundedToBuyer(
        bytes32 indexed escrowId,
        address indexed buyer,
        uint256 amount
    );

    // ── Errors ────────────────────────────────────────────────────────────────
    error EscrowAlreadyExists(bytes32 escrowId);
    error EscrowNotFound(bytes32 escrowId);
    error InvalidState(bytes32 escrowId, EscrowState current, EscrowState required);
    error HoldDeadlineNotReached(bytes32 escrowId, uint256 deadline, uint256 currentTime);
    error ZeroAmount();
    error ZeroAddress();
    error InvalidHoldDeadline();

    // ── Constructor ───────────────────────────────────────────────────────────
    /**
     * @param _usdc      USDC 컨트랙트 주소 (Base Sepolia: 0x036CbD53842c5426634e7929541eC2318f3dCF7e)
     * @param _operator  운영자 지갑 주소
     */
    constructor(address _usdc, address _operator) {
        if (_usdc == address(0) || _operator == address(0)) revert ZeroAddress();

        usdc = IERC20(_usdc);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, _operator);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. createEscrow — Seller 지급 예정 금액을 Escrow에 잠금
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * @notice Perun 정산 완료 후 운영자가 Seller 지급 금액을 Escrow에 예치
     * @param escrowId      고유 식별자 (bytes32, 보통 sessionId 기반)
     * @param buyer         사용자 지갑 주소
     * @param seller        운영자/판매자 지갑 주소
     * @param amount        Hold할 USDC 금액 (6 decimals)
     * @param holdDeadline  이 타임스탬프 이후에만 releaseToSeller 가능
     *
     * @dev 호출 전: operator가 USDC 컨트랙트에 approve(escrowAddress, amount) 필요
     */
    function createEscrow(
        bytes32 escrowId,
        address buyer,
        address seller,
        uint256 amount,
        uint256 holdDeadline
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        if (escrows[escrowId].state != EscrowState.None)
            revert EscrowAlreadyExists(escrowId);
        if (amount == 0)              revert ZeroAmount();
        if (buyer == address(0))      revert ZeroAddress();
        if (seller == address(0))     revert ZeroAddress();
        if (holdDeadline <= block.timestamp) revert InvalidHoldDeadline();

        // Checks-Effects-Interactions
        escrows[escrowId] = EscrowRecord({
            buyer:        buyer,
            seller:       seller,
            amount:       amount,
            holdDeadline: holdDeadline,
            state:        EscrowState.Held
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit EscrowCreated(escrowId, buyer, seller, amount, holdDeadline);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. registerRefundIssue — 문제 발생 기록 → RefundIssue 상태로 전환
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * @notice unlock failure, device fault, wrong charge 등 문제를 기록하고
     *         Escrow를 RefundIssue 상태로 전환
     * @param escrowId    대상 Escrow ID
     * @param issueType   IssueType enum 값
     * @param description 문제 상세 설명 (백엔드 caseId 등 포함 권장)
     *
     * @dev Held 상태에서만 호출 가능 (이미 Released/Refunded면 불가)
     */
    function registerRefundIssue(
        bytes32 escrowId,
        IssueType issueType,
        string calldata description
    ) external onlyRole(OPERATOR_ROLE) {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None)
            revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.Held)
            revert InvalidState(escrowId, rec.state, EscrowState.Held);

        rec.state = EscrowState.RefundIssue;

        issues[escrowId] = IssueRecord({
            issueType:    issueType,
            description:  description,
            registeredAt: block.timestamp
        });

        emit RefundIssueRegistered(escrowId, issueType, description, block.timestamp);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. releaseToSeller — 문제 없음 + holdDeadline 경과 → Seller에게 즉시 송금 (Push)
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * @notice 문제가 없고 holdDeadline이 지난 경우 Seller에게 USDC 직접 전송
     * @param escrowId  대상 Escrow ID
     *
     * @dev holdDeadline 이전에 호출하면 revert
     *      RefundIssue 상태(문제 등록됨)에서는 호출 불가
     */
    function releaseToSeller(
        bytes32 escrowId
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None)
            revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.Held)
            revert InvalidState(escrowId, rec.state, EscrowState.Held);
        if (block.timestamp < rec.holdDeadline)
            revert HoldDeadlineNotReached(escrowId, rec.holdDeadline, block.timestamp);

        uint256 amount  = rec.amount;
        address seller  = rec.seller;

        // Effects before Interactions
        rec.state  = EscrowState.Released;
        rec.amount = 0;

        // Push: 바로 Seller에게 전송
        usdc.safeTransfer(seller, amount);

        emit ReleasedToSeller(escrowId, seller, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. refundToBuyer — 문제 확인 → Buyer에게 즉시 환불 (Push)
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * @notice RefundIssue 상태에서 운영자가 환불 승인 시 Buyer에게 USDC 직접 전송
     * @param escrowId  대상 Escrow ID
     *
     * @dev holdDeadline과 무관하게 즉시 실행 가능 (운영자 승인이 조건)
     *      RefundIssue 상태에서만 호출 가능
     */
    function refundToBuyer(
        bytes32 escrowId
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None)
            revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.RefundIssue)
            revert InvalidState(escrowId, rec.state, EscrowState.RefundIssue);

        uint256 amount = rec.amount;
        address buyer  = rec.buyer;

        // Effects before Interactions
        rec.state  = EscrowState.Refunded;
        rec.amount = 0;

        // Push: 바로 Buyer에게 전송
        usdc.safeTransfer(buyer, amount);

        emit RefundedToBuyer(escrowId, buyer, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. getEscrowStatus — Escrow 상태 조회
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * @notice Escrow 전체 상태를 반환
     * @return state        현재 상태 (Held / RefundIssue / Released / Refunded)
     * @return amount       현재 Hold된 금액
     * @return buyer        사용자 주소
     * @return seller       판매자 주소
     * @return holdDeadline releaseToSeller 가능 시각
     * @return isDeadlinePassed holdDeadline이 지났는지 여부
     */
    function getEscrowStatus(bytes32 escrowId) external view returns (
        EscrowState state,
        uint256 amount,
        address buyer,
        address seller,
        uint256 holdDeadline,
        bool isDeadlinePassed
    ) {
        EscrowRecord storage rec = escrows[escrowId];
        return (
            rec.state,
            rec.amount,
            rec.buyer,
            rec.seller,
            rec.holdDeadline,
            block.timestamp >= rec.holdDeadline
        );
    }

    /**
     * @notice 등록된 Issue 정보 조회
     */
    function getIssueRecord(bytes32 escrowId) external view returns (
        IssueType issueType,
        string memory description,
        uint256 registeredAt
    ) {
        IssueRecord storage issue = issues[escrowId];
        return (issue.issueType, issue.description, issue.registeredAt);
    }

    /**
     * @notice holdDeadline이 지났는지만 빠르게 확인
     */
    function isDeadlinePassed(bytes32 escrowId) external view returns (bool) {
        return block.timestamp >= escrows[escrowId].holdDeadline;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: 비상 취소 (Admin만 가능)
    // ─────────────────────────────────────────────────────────────────────────
    /**
     * @notice 비상 상황에서 Admin이 Escrow를 취소하고 Buyer에게 전액 반환
     */
    function emergencyCancel(
        bytes32 escrowId
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        if (rec.state == EscrowState.Released || rec.state == EscrowState.Refunded)
            revert InvalidState(escrowId, rec.state, EscrowState.Held);

        uint256 amount = rec.amount;
        address buyer  = rec.buyer;

        rec.state  = EscrowState.Refunded;
        rec.amount = 0;

        usdc.safeTransfer(buyer, amount);
        emit RefundedToBuyer(escrowId, buyer, amount);
    }
}
