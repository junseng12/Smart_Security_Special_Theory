// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SmartCityEscrowV3
 * @notice Perun AssetHolder 원본 구조 그대로 — 사용자 + operator 양측 예치
 *
 * ── Perun AssetHolder 원본 대응 ───────────────────────────────────────────────
 *
 *  Perun 원본                         SmartCity 대응
 *  ─────────────────────────────────  ──────────────────────────────────────
 *  deposit(fundingID, amount)         userDeposit()  + operatorDeposit()
 *  holdings[fundingID] += amount      escrows[id].userDeposit / operatorDeposit
 *  setOutcome(channelID, newBals)     settleAndRelease(escrowId, fareAmount)
 *  withdraw(auth, sig)                내부 safeTransfer (Push 방식으로 단순화)
 *
 * ── 자금 흐름 ─────────────────────────────────────────────────────────────────
 *
 *  세션 시작:
 *    [사용자 MetaMask] --approve + userDeposit()--> [Escrow]  (보증금)
 *    [operator 백엔드] --approve + operatorDeposit()--> [Escrow]  (서비스 보증금)
 *
 *  정상 정산 (settleAndRelease):
 *    [Escrow] --fareAmount--> seller(operator)   (요금)
 *    [Escrow] --userDeposit - fare--> user        (잔금 환불)
 *    [Escrow] --operatorDeposit--> operator       (보증금 반환)
 *
 *  환불 케이스 (refundToBuyer):
 *    [Escrow] --userDeposit--> user               (전액 환불)
 *    [Escrow] --operatorDeposit--> user            (penalty: operator 보증금도 사용자에게)
 *    or
 *    [Escrow] --operatorDeposit--> operator        (정책에 따라)
 *
 * ── 핵심 보안 원칙 ─────────────────────────────────────────────────────────────
 *  - operator가 settleAndRelease를 안 하면 사용자는 holdDeadline 후 forceRefund() 가능
 *  - operator 보증금이 잠겨있으므로 operator가 사기칠 인센티브 없음
 *  - 환불 시 operator penalty 옵션으로 악의적 서비스 제공 억제
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SmartCityEscrowV3 is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    enum EscrowState {
        None,               // 미생성
        UserDeposited,      // 사용자만 예치
        FullyFunded,        // 양측 예치 완료 → 서비스 진행
        RefundIssue,        // 환불 이슈 등록
        Released,           // 정상 정산 완료
        Refunded            // 환불 완료
    }

    struct EscrowRecord {
        address user;           // 사용자 (예치자 & 환불 수신자)
        address operator;       // 서비스 제공자 (요금 수신자 & 보증금 예치자)
        uint256 userDeposit;    // 사용자 예치 보증금 (6 decimals)
        uint256 operatorDeposit;// operator 서비스 보증금
        uint256 fareAmount;     // 실제 청구 요금 (settleAndRelease 시 확정)
        uint256 holdDeadline;   // 이 시각 이후 settleAndRelease 가능
        bool    penalizeOperator; // 환불 시 operator penalty 적용 여부
        EscrowState state;
    }

    struct IssueRecord {
        uint8   issueType;
        string  description;
        uint256 registeredAt;
    }

    IERC20 public immutable usdc;
    mapping(bytes32 => EscrowRecord) public escrows;
    mapping(bytes32 => IssueRecord)  public issues;

    // ── Events ────────────────────────────────────────────────────────────────
    event UserDeposited(bytes32 indexed escrowId, address indexed user, address indexed operator, uint256 amount, uint256 holdDeadline);
    event OperatorDeposited(bytes32 indexed escrowId, address indexed operator, uint256 amount);
    event SettledAndReleased(bytes32 indexed escrowId, address indexed operator, uint256 fare, address indexed user, uint256 refund, uint256 operatorRefund);
    event RefundIssueRegistered(bytes32 indexed escrowId, uint8 issueType, string description);
    event RefundedToBuyer(bytes32 indexed escrowId, address indexed user, uint256 amount, uint256 penalty);
    event ForceRefunded(bytes32 indexed escrowId, address indexed user, uint256 amount);

    // ── Errors ────────────────────────────────────────────────────────────────
    error EscrowAlreadyExists(bytes32 escrowId);
    error EscrowNotFound(bytes32 escrowId);
    error InvalidState(EscrowState current);
    error HoldDeadlineNotReached(uint256 deadline, uint256 now_);
    error HoldDeadlineAlreadyPassed();
    error FareExceedsDeposit(uint256 fare, uint256 deposit);
    error ZeroAmount();
    error ZeroAddress();
    error InvalidHoldDeadline();
    error NotUser();

    constructor(address _usdc, address _operator) {
        if (_usdc == address(0) || _operator == address(0)) revert ZeroAddress();
        usdc = IERC20(_usdc);
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, _operator);
        _grantRole(OPERATOR_ROLE, msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. userDeposit — 사용자가 직접 USDC 예치 (Perun deposit() 대응)
    //    프론트 MetaMask에서 직접 호출
    // ─────────────────────────────────────────────────────────────────────────
    function userDeposit(
        bytes32 escrowId,
        address operator,   // 서비스 제공자 (요금 수신자)
        uint256 amount,
        uint256 holdDeadline
    ) external nonReentrant {
        if (escrows[escrowId].state != EscrowState.None) revert EscrowAlreadyExists(escrowId);
        if (amount == 0)                     revert ZeroAmount();
        if (operator == address(0))          revert ZeroAddress();
        if (holdDeadline <= block.timestamp) revert InvalidHoldDeadline();

        // Perun depositEnact: transferFrom 사용자 → 컨트랙트
        escrows[escrowId] = EscrowRecord({
            user:             msg.sender,
            operator:         operator,
            userDeposit:      amount,
            operatorDeposit:  0,
            fareAmount:       0,
            holdDeadline:     holdDeadline,
            penalizeOperator: false,
            state:            EscrowState.UserDeposited
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit UserDeposited(escrowId, msg.sender, operator, amount, holdDeadline);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. operatorDeposit — operator 서비스 보증금 예치 (백엔드 자동 호출)
    //    Perun: operator도 deposit(operatorFundingID, reserve)
    // ─────────────────────────────────────────────────────────────────────────
    function operatorDeposit(
        bytes32 escrowId,
        uint256 amount
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];
        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.UserDeposited) revert InvalidState(rec.state);
        if (amount == 0) revert ZeroAmount();

        rec.operatorDeposit = amount;
        rec.state = EscrowState.FullyFunded;

        // Perun depositEnact: operator USDC → 컨트랙트
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit OperatorDeposited(escrowId, msg.sender, amount);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. settleAndRelease — 정상 정산 (Perun setOutcome + withdraw 대응)
    //    Perun: setOutcome(channelID, parts, newBals) → 각자 withdraw
    //    우리:  한번에 Push로 분배 (gas 절약, UX 단순화)
    // ─────────────────────────────────────────────────────────────────────────
    function settleAndRelease(
        bytes32 escrowId,
        uint256 fareAmount
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        // FullyFunded OR UserDeposited (operator deposit 없어도 정산 허용 — 유연성)
        if (rec.state != EscrowState.FullyFunded && rec.state != EscrowState.UserDeposited)
            revert InvalidState(rec.state);
        if (block.timestamp < rec.holdDeadline)
            revert HoldDeadlineNotReached(rec.holdDeadline, block.timestamp);
        if (fareAmount > rec.userDeposit)
            revert FareExceedsDeposit(fareAmount, rec.userDeposit);

        uint256 userRefund     = rec.userDeposit - fareAmount;
        uint256 opRefund       = rec.operatorDeposit;
        address user           = rec.user;
        address operator       = rec.operator;

        // Effects first
        rec.state           = EscrowState.Released;
        rec.fareAmount      = fareAmount;
        rec.userDeposit     = 0;
        rec.operatorDeposit = 0;

        // Interactions (Perun withdrawEnact 방식)
        if (fareAmount > 0) usdc.safeTransfer(operator, fareAmount); // 요금 → operator
        if (userRefund > 0) usdc.safeTransfer(user, userRefund);     // 잔금 → 사용자
        if (opRefund > 0)   usdc.safeTransfer(operator, opRefund);   // 보증금 반환 → operator

        emit SettledAndReleased(escrowId, operator, fareAmount, user, userRefund, opRefund);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. registerRefundIssue — 이슈 등록 (operator 또는 사용자)
    // ─────────────────────────────────────────────────────────────────────────
    function registerRefundIssue(
        bytes32 escrowId,
        uint8   issueType,
        string calldata description,
        bool    penalizeOperator  // true: operator 보증금도 사용자에게 (심각한 케이스)
    ) external nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];
        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.FullyFunded && rec.state != EscrowState.UserDeposited)
            revert InvalidState(rec.state);

        // operator 또는 사용자 본인만 이슈 등록 가능
        bool isOp   = hasRole(OPERATOR_ROLE, msg.sender);
        bool isUser = (msg.sender == rec.user);
        require(isOp || isUser, "Not authorized");

        rec.state            = EscrowState.RefundIssue;
        rec.penalizeOperator = penalizeOperator;
        issues[escrowId] = IssueRecord({ issueType: issueType, description: description, registeredAt: block.timestamp });

        emit RefundIssueRegistered(escrowId, issueType, description);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. refundToBuyer — 이슈 승인 후 환불 (operator 호출)
    //    penalizeOperator=true 이면 operator 보증금도 사용자에게
    // ─────────────────────────────────────────────────────────────────────────
    function refundToBuyer(bytes32 escrowId) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];
        if (rec.state == EscrowState.None)        revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.RefundIssue) revert InvalidState(rec.state);

        uint256 userAmount    = rec.userDeposit;
        uint256 opDeposit     = rec.operatorDeposit;
        bool    penalty       = rec.penalizeOperator;
        address user          = rec.user;
        address operator      = rec.operator;

        rec.state           = EscrowState.Refunded;
        rec.userDeposit     = 0;
        rec.operatorDeposit = 0;

        // 사용자 보증금 전액 환불
        if (userAmount > 0) usdc.safeTransfer(user, userAmount);

        if (opDeposit > 0) {
            if (penalty) {
                // operator 사기/과실 → 보증금도 사용자에게 (패널티)
                usdc.safeTransfer(user, opDeposit);
            } else {
                // 단순 서비스 불만 → 보증금 operator에게 반환
                usdc.safeTransfer(operator, opDeposit);
            }
        }

        emit RefundedToBuyer(escrowId, user, userAmount, penalty ? opDeposit : 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. forceRefund — holdDeadline 경과 후 operator가 정산 안 하면 사용자가 직접 호출
    //    Perun dispute 메커니즘 대응
    // ─────────────────────────────────────────────────────────────────────────
    function forceRefund(bytes32 escrowId) external nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];
        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        if (msg.sender != rec.user) revert NotUser();
        if (rec.state != EscrowState.FullyFunded && rec.state != EscrowState.UserDeposited)
            revert InvalidState(rec.state);

        // holdDeadline의 2배 지나도 정산 안 했을 때만 허용 (operator에게 충분한 시간)
        uint256 forceDeadline = rec.holdDeadline + (rec.holdDeadline - block.timestamp > 0
            ? 0 : rec.holdDeadline);
        // 단순화: holdDeadline + 1시간 후 forceRefund 가능
        require(block.timestamp >= rec.holdDeadline + 3600, "Too early for force refund");

        uint256 userAmount = rec.userDeposit;
        uint256 opDeposit  = rec.operatorDeposit;
        address user       = rec.user;
        address operator   = rec.operator;

        rec.state           = EscrowState.Refunded;
        rec.userDeposit     = 0;
        rec.operatorDeposit = 0;

        // 사용자 전액 환불 + operator 보증금도 사용자에게 (정산 거부 = 패널티)
        if (userAmount > 0) usdc.safeTransfer(user, userAmount);
        if (opDeposit  > 0) usdc.safeTransfer(user, opDeposit);  // 패널티

        emit ForceRefunded(escrowId, user, userAmount + opDeposit);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. getEscrowStatus — 상태 조회
    // ─────────────────────────────────────────────────────────────────────────
    function getEscrowStatus(bytes32 escrowId) external view returns (
        EscrowState state,
        uint256 userDeposit,
        uint256 operatorDeposit,
        uint256 fareAmount,
        address user,
        address operator,
        uint256 holdDeadline,
        bool    isFullyFunded,
        bool    isDeadlinePassed
    ) {
        EscrowRecord storage rec = escrows[escrowId];
        return (
            rec.state,
            rec.userDeposit,
            rec.operatorDeposit,
            rec.fareAmount,
            rec.user,
            rec.operator,
            rec.holdDeadline,
            rec.state == EscrowState.FullyFunded,
            block.timestamp >= rec.holdDeadline
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. emergencyCancel — 관리자 긴급 취소
    // ─────────────────────────────────────────────────────────────────────────
    function emergencyCancel(bytes32 escrowId) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];
        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        require(
            rec.state != EscrowState.Released && rec.state != EscrowState.Refunded,
            "Already finalized"
        );

        uint256 userAmt = rec.userDeposit;
        uint256 opAmt   = rec.operatorDeposit;
        address user    = rec.user;
        address operator = rec.operator;

        rec.state           = EscrowState.Refunded;
        rec.userDeposit     = 0;
        rec.operatorDeposit = 0;

        if (userAmt > 0) usdc.safeTransfer(user, userAmt);
        if (opAmt   > 0) usdc.safeTransfer(operator, opAmt);

        emit RefundedToBuyer(escrowId, user, userAmt, 0);
    }
}
