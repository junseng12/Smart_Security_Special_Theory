// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title SmartCityEscrow
 * @notice SmartCityEscrow V3.2 for smart-city shared bike payment.
 *
 * Core idea:
 * - The contract acts like a card-network-style intermediary.
 * - settleAndRelease() does NOT transfer funds immediately.
 * - It records a pending settlement and opens a 24-hour dispute window.
 * - If there is no dispute, claimSettlement() transfers the reserved funds.
 * - If there is a dispute, registerRefundIssue() and refundToBuyer() handle refund.
 *
 * Refund policy in this version:
 * - Operator deposit is NEVER paid to the user.
 * - Operator deposit always returns to the operator.
 * - The user only receives the refundable portion of the user's own deposit.
 *
 * Backend ABI compatibility target:
 * - userDeposit(bytes32,address,uint256,uint256)
 * - operatorDeposit(bytes32,uint256)
 * - settleAndRelease(bytes32,uint256)
 * - registerRefundIssue(bytes32,uint8,string,bool)
 * - refundToBuyer(bytes32,uint256)
 * - forceRefund(bytes32)
 * - emergencyCancel(bytes32)
 * - getEscrowStatus(bytes32)
 *
 * Additional function for delayed settlement:
 * - claimSettlement(bytes32)
 *
 * State order must match backend STATE_LABELS:
 * ['None','UserDeposited','FullyFunded','RefundIssue','Released','Refunded']
 */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SmartCityEscrow is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Roles
    // -------------------------------------------------------------------------
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // -------------------------------------------------------------------------
    // Time constants
    // -------------------------------------------------------------------------
    uint256 public constant CLAIM_PERIOD = 24 hours;
    uint256 public constant FORCE_REFUND_GRACE_PERIOD = 1 hours;

    // -------------------------------------------------------------------------
    // Escrow state
    // IMPORTANT: order must match backend STATE_LABELS.
    // -------------------------------------------------------------------------
    enum EscrowState {
        None,
        UserDeposited,
        FullyFunded,
        RefundIssue,
        Released,
        Refunded
    }

    // issueType mapping expected by backend:
    // unlock_failure:0, device_fault:1, wrong_charge:2,
    // sensor_failure:3, service_outage:4, other:5
    enum IssueType {
        UnlockFailure,
        DeviceFault,
        WrongCharge,
        SensorFailure,
        ServiceOutage,
        Other
    }

    struct EscrowRecord {
        address user;
        address operator;

        uint256 userDeposit;
        uint256 operatorDeposit;

        // Final fare amount submitted by backend / Perun settlement result.
        uint256 fareAmount;

        // Original service deadline.
        uint256 holdDeadline;

        // Kept only for backend ABI compatibility.
        // In this version, operator deposit is never transferred to the user.
        bool penalizeOperator;

        EscrowState state;

        // ---------------------------------------------------------------------
        // Settlement reservation fields
        // ---------------------------------------------------------------------
        // claimableAfter = settleAndRelease timestamp + CLAIM_PERIOD.
        uint256 claimableAfter;

        // Pending settlement amounts recorded by settleAndRelease().
        // Funds remain in this contract until claimSettlement() or refundToBuyer().
        uint256 fareClaimed;
        uint256 userRefundClaimed;
        uint256 operatorRefundClaimed;

        // Prevent duplicate claimSettlement() execution while keeping Released state
        // for backend state-label compatibility.
        bool settlementClaimed;
    }

    struct IssueRecord {
        IssueType issueType;
        string description;

        // Kept only for backend ABI compatibility.
        // Always stored as false in this version.
        bool penalizeOperator;

        uint256 registeredAt;
    }

    IERC20 public immutable usdc;

    mapping(bytes32 => EscrowRecord) private escrows;
    mapping(bytes32 => IssueRecord) private issues;

    // -------------------------------------------------------------------------
    // On-chain evidence events
    // -------------------------------------------------------------------------

    // Evidence 1: user deposit entered the escrow contract.
    event UserDeposited(
        bytes32 indexed escrowId,
        address indexed user,
        address indexed operator,
        uint256 amount,
        uint256 holdDeadline
    );

    // Evidence 2: operator guarantee deposit entered the escrow contract.
    event OperatorDeposited(
        bytes32 indexed escrowId,
        address indexed operator,
        uint256 amount
    );

    /**
     * @dev Kept for backend ABI compatibility.
     * In V3.1 this event means "settlement has been reserved",
     * not "funds have already been transferred".
     */
    event SettledAndReleased(
        bytes32 indexed escrowId,
        address indexed operator,
        uint256 fare,
        address indexed user,
        uint256 refund,
        uint256 operatorRefund
    );

    // Evidence 3: settlement was reserved and the 24-hour dispute window started.
    event SettlementReserved(
        bytes32 indexed escrowId,
        address indexed operator,
        uint256 fare,
        address indexed user,
        uint256 userRefund,
        uint256 operatorRefund,
        uint256 claimableAfter
    );

    // Evidence 4: refund issue was registered during the valid dispute window.
    event RefundIssueRegistered(
        bytes32 indexed escrowId,
        uint8 issueType,
        string description,
        bool penalizeOperator,
        uint256 registeredAt
    );

    // Evidence 5: refund was actually executed.
    // penalty is always 0 in this version because operator deposit is never paid to user.
    event RefundedToBuyer(
        bytes32 indexed escrowId,
        address indexed user,
        uint256 amount,
        uint256 penalty
    );

    // Evidence 6: settlement was claimed after the 24-hour dispute window.
    event SettlementClaimed(
        bytes32 indexed escrowId,
        address indexed operator,
        uint256 fare,
        address indexed user,
        uint256 userRefund,
        uint256 operatorRefund
    );

    // Evidence 7: admin-only recovery was executed.
    event EmergencyCancelled(
        bytes32 indexed escrowId,
        address indexed user,
        address indexed operator,
        uint256 userRefund,
        uint256 operatorRefund
    );

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------
    error ZeroAddress();
    error ZeroAmount();
    error EscrowAlreadyExists(bytes32 escrowId);
    error EscrowNotFound(bytes32 escrowId);
    error InvalidState(bytes32 escrowId, EscrowState current);
    error InvalidHoldDeadline();
    error NotEscrowOperator(bytes32 escrowId, address caller);
    error OperatorNotAuthorized(address operator);
    error FareExceedsUserDeposit(uint256 fareAmount, uint256 userDeposit);
    error DeadlineNotPassed(bytes32 escrowId, uint256 requiredTime, uint256 currentTime);
    error ClaimPeriodEnded(bytes32 escrowId, uint256 claimableAfter, uint256 currentTime);
    error ClaimPeriodNotEnded(bytes32 escrowId, uint256 claimableAfter, uint256 currentTime);
    error SettlementAlreadyClaimed(bytes32 escrowId);
    error InvalidIssueType(uint8 issueType);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------
    /**
     * @param _usdc USDC or stablecoin contract address
     * @param _operator backend/operator wallet address
     */
    constructor(address _usdc, address _operator) {
        if (_usdc == address(0) || _operator == address(0)) revert ZeroAddress();

        usdc = IERC20(_usdc);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, msg.sender);
        _grantRole(OPERATOR_ROLE, _operator);
    }

    // -------------------------------------------------------------------------
    // 1. userDeposit
    // -------------------------------------------------------------------------
    /**
     * @notice User deposits stablecoin before starting the service.
     * @dev The user must call USDC.approve(escrowContract, amount) first.
     */
    function userDeposit(
        bytes32 escrowId,
        address operator,
        uint256 amount,
        uint256 holdDeadline
    ) external nonReentrant {
        if (escrows[escrowId].state != EscrowState.None) {
            revert EscrowAlreadyExists(escrowId);
        }
        if (operator == address(0)) revert ZeroAddress();
        if (!hasRole(OPERATOR_ROLE, operator)) {
            revert OperatorNotAuthorized(operator);
        }
        if (amount == 0) revert ZeroAmount();
        if (holdDeadline <= block.timestamp) revert InvalidHoldDeadline();

        escrows[escrowId] = EscrowRecord({
            user: msg.sender,
            operator: operator,
            userDeposit: amount,
            operatorDeposit: 0,
            fareAmount: 0,
            holdDeadline: holdDeadline,
            penalizeOperator: false,
            state: EscrowState.UserDeposited,
            claimableAfter: 0,
            fareClaimed: 0,
            userRefundClaimed: 0,
            operatorRefundClaimed: 0,
            settlementClaimed: false
        });

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit UserDeposited(escrowId, msg.sender, operator, amount, holdDeadline);
    }

    // -------------------------------------------------------------------------
    // 2. operatorDeposit
    // -------------------------------------------------------------------------
    /**
     * @notice Operator deposits its guarantee deposit.
     * @dev Called by backend/operator after userDeposit is confirmed.
     */
    function operatorDeposit(
        bytes32 escrowId,
        uint256 amount
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.UserDeposited) revert InvalidState(escrowId, rec.state);
        if (amount == 0) revert ZeroAmount();
        if (msg.sender != rec.operator) revert NotEscrowOperator(escrowId, msg.sender);

        rec.operatorDeposit = amount;
        rec.state = EscrowState.FullyFunded;

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit OperatorDeposited(escrowId, msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // 3. settleAndRelease
    // -------------------------------------------------------------------------
    /**
     * @notice Reserve settlement after ride ends.
     * @dev This function DOES NOT transfer funds immediately.
     *      It records pending settlement amounts and opens a 24-hour dispute window.
     */
    function settleAndRelease(
        bytes32 escrowId,
        uint256 fareAmount
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);

        // Strict policy: normal settlement requires both user and operator deposits.
        if (rec.state != EscrowState.FullyFunded) {
            revert InvalidState(escrowId, rec.state);
        }

        if (msg.sender != rec.operator) revert NotEscrowOperator(escrowId, msg.sender);

        if (block.timestamp < rec.holdDeadline) {
            revert DeadlineNotPassed(escrowId, rec.holdDeadline, block.timestamp);
        }

        if (fareAmount > rec.userDeposit) {
            revert FareExceedsUserDeposit(fareAmount, rec.userDeposit);
        }

        uint256 userRefund = rec.userDeposit - fareAmount;
        uint256 operatorRefund = rec.operatorDeposit;
        uint256 claimableAfter = block.timestamp + CLAIM_PERIOD;

        rec.fareAmount = fareAmount;
        rec.fareClaimed = fareAmount;
        rec.userRefundClaimed = userRefund;
        rec.operatorRefundClaimed = operatorRefund;
        rec.claimableAfter = claimableAfter;
        rec.settlementClaimed = false;

        // Released now means "settlement reserved and waiting for dispute window".
        rec.state = EscrowState.Released;

        emit SettlementReserved(
            escrowId,
            rec.operator,
            fareAmount,
            rec.user,
            userRefund,
            operatorRefund,
            claimableAfter
        );

        // Kept for existing backend event listeners.
        // In this version, it means "settlement reserved", not "payout completed".
        emit SettledAndReleased(
            escrowId,
            rec.operator,
            fareAmount,
            rec.user,
            userRefund,
            operatorRefund
        );
    }

    // -------------------------------------------------------------------------
    // 4. claimSettlement
    // -------------------------------------------------------------------------
    /**
     * @notice Claim reserved settlement after 24-hour dispute window.
     * @dev Anyone can call this after claimableAfter.
     *
     * Transfers:
     * - fareClaimed -> operator
     * - userRefundClaimed -> user
     * - operatorRefundClaimed -> operator
     */
    function claimSettlement(bytes32 escrowId) external nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.Released) revert InvalidState(escrowId, rec.state);
        if (rec.settlementClaimed) revert SettlementAlreadyClaimed(escrowId);

        if (block.timestamp < rec.claimableAfter) {
            revert ClaimPeriodNotEnded(escrowId, rec.claimableAfter, block.timestamp);
        }

        uint256 fare = rec.fareClaimed;
        uint256 userRefund = rec.userRefundClaimed;
        uint256 operatorRefund = rec.operatorRefundClaimed;

        address user = rec.user;
        address operator = rec.operator;

        // Prevent duplicate claims.
        rec.fareClaimed = 0;
        rec.userRefundClaimed = 0;
        rec.operatorRefundClaimed = 0;
        rec.settlementClaimed = true;

        // State remains Released as final normal-settlement state
        // for backend STATE_LABELS compatibility.
        if (fare > 0) {
            usdc.safeTransfer(operator, fare);
        }
        if (userRefund > 0) {
            usdc.safeTransfer(user, userRefund);
        }
        if (operatorRefund > 0) {
            usdc.safeTransfer(operator, operatorRefund);
        }

        emit SettlementClaimed(
            escrowId,
            operator,
            fare,
            user,
            userRefund,
            operatorRefund
        );
    }

    // -------------------------------------------------------------------------
    // 5. registerRefundIssue
    // -------------------------------------------------------------------------
    /**
     * @notice Record refund issue.
     * @dev This does not transfer funds.
     *
     * The penalizeOperator parameter is kept for backend ABI compatibility.
     * It is ignored internally because operator deposit is never paid to user.
     */
    function registerRefundIssue(
        bytes32 escrowId,
        uint8 issueType,
        string calldata description,
        bool /* penalizeOperator */
    ) external onlyRole(OPERATOR_ROLE) {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);

        if (
            rec.state != EscrowState.UserDeposited &&
            rec.state != EscrowState.FullyFunded &&
            rec.state != EscrowState.Released
        ) {
            revert InvalidState(escrowId, rec.state);
        }

        if (msg.sender != rec.operator) revert NotEscrowOperator(escrowId, msg.sender);

        if (rec.state == EscrowState.Released) {
            if (rec.settlementClaimed) revert SettlementAlreadyClaimed(escrowId);
            if (block.timestamp >= rec.claimableAfter) {
                revert ClaimPeriodEnded(escrowId, rec.claimableAfter, block.timestamp);
            }
        }

        if (issueType > uint8(IssueType.Other)) revert InvalidIssueType(issueType);
        IssueType parsedIssueType = IssueType(issueType);

        rec.state = EscrowState.RefundIssue;
        rec.penalizeOperator = false;

        issues[escrowId] = IssueRecord({
            issueType: parsedIssueType,
            description: description,
            penalizeOperator: false,
            registeredAt: block.timestamp
        });

        emit RefundIssueRegistered(
            escrowId,
            uint8(parsedIssueType),
            description,
            false,
            block.timestamp
        );
    }

    // -------------------------------------------------------------------------
    // 6. refundToBuyer
    // -------------------------------------------------------------------------
    /**
     * @notice Execute refund after refund issue is registered.
     * @dev Operator deposit is never paid to user. It always returns to operator.
     */
    /**
     * @notice Execute refund after refund issue is registered.
     * @param escrowId  Target escrow.
     * @param refundFare  Fare amount to transfer to operator even on refund.
     *   Pass 0 for full refund cases (unlock failure, complete service outage).
     *   Pass the actual fare for partial-use cases (device fault mid-ride).
     *   Must not exceed fareClaimed (or userDeposit when no settlement was reserved).
     * @dev The backend (channelOrchestrator) decides refundFare based on issueType
     *      and confirmed usage data before calling this function.
     */
    function refundToBuyer(
        bytes32 escrowId,
        uint256 refundFare
    ) external onlyRole(OPERATOR_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        if (rec.state != EscrowState.RefundIssue) revert InvalidState(escrowId, rec.state);
        if (msg.sender != rec.operator) revert NotEscrowOperator(escrowId, msg.sender);

        // refundFare must not exceed the maximum chargeable amount
        uint256 maxFare = rec.claimableAfter > 0 ? rec.fareClaimed : rec.userDeposit;
        if (refundFare > maxFare) revert FareExceedsUserDeposit(refundFare, maxFare);

        _executeRefundToBuyer(escrowId, rec, refundFare);
    }

    // -------------------------------------------------------------------------
    // 7. forceRefund
    // -------------------------------------------------------------------------
    /**
     * @notice Force refund after holdDeadline + grace period.
     * @dev Anyone can call after timeout. Funds go to original recipients.
     */
    function forceRefund(bytes32 escrowId) external nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);

        if (
            rec.state != EscrowState.UserDeposited &&
            rec.state != EscrowState.FullyFunded &&
            rec.state != EscrowState.RefundIssue
        ) {
            revert InvalidState(escrowId, rec.state);
        }

        uint256 requiredTime = rec.holdDeadline + FORCE_REFUND_GRACE_PERIOD;
        if (block.timestamp < requiredTime) {
            revert DeadlineNotPassed(escrowId, requiredTime, block.timestamp);
        }

        _executeForceRefund(escrowId, rec);
    }

    // -------------------------------------------------------------------------
    // 8. emergencyCancel
    // -------------------------------------------------------------------------
    /**
     * @notice Admin emergency cancellation.
     * @dev This is not part of the normal payment/refund flow.
     */
    function emergencyCancel(
        bytes32 escrowId
    ) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        EscrowRecord storage rec = escrows[escrowId];

        if (rec.state == EscrowState.None) revert EscrowNotFound(escrowId);
        if (rec.state == EscrowState.Refunded) revert InvalidState(escrowId, rec.state);
        if (rec.settlementClaimed) revert SettlementAlreadyClaimed(escrowId);

        uint256 userRefund = rec.userDeposit;
        uint256 operatorRefund = rec.operatorDeposit;

        address user = rec.user;
        address operator = rec.operator;

        rec.state = EscrowState.Refunded;
        rec.fareClaimed = 0;
        rec.userRefundClaimed = 0;
        rec.operatorRefundClaimed = 0;
        rec.settlementClaimed = true;

        if (userRefund > 0) {
            usdc.safeTransfer(user, userRefund);
        }
        if (operatorRefund > 0) {
            usdc.safeTransfer(operator, operatorRefund);
        }

        emit EmergencyCancelled(
            escrowId,
            user,
            operator,
            userRefund,
            operatorRefund
        );

        emit RefundedToBuyer(escrowId, user, userRefund, 0);
    }

    // -------------------------------------------------------------------------
    // 9. getEscrowStatus
    // -------------------------------------------------------------------------
    /**
     * @notice Return status values in the exact order expected by backend.
     */
    function getEscrowStatus(bytes32 escrowId)
        external
        view
        returns (
            uint8 state,
            uint256 userDepositAmount,
            uint256 operatorDepositAmount,
            uint256 fareAmount,
            address user,
            address operator,
            uint256 holdDeadline,
            bool isFullyFunded,
            bool deadlinePassed
        )
    {
        EscrowRecord storage rec = escrows[escrowId];

        return (
            uint8(rec.state),
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

    // -------------------------------------------------------------------------
    // View helpers
    // -------------------------------------------------------------------------
    function getIssueRecord(bytes32 escrowId)
        external
        view
        returns (
            uint8 issueType,
            string memory description,
            bool penalizeOperator,
            uint256 registeredAt
        )
    {
        IssueRecord storage issue = issues[escrowId];

        return (
            uint8(issue.issueType),
            issue.description,
            issue.penalizeOperator,
            issue.registeredAt
        );
    }

    function isDeadlinePassed(bytes32 escrowId) external view returns (bool) {
        return block.timestamp >= escrows[escrowId].holdDeadline;
    }

    function isClaimable(bytes32 escrowId) external view returns (bool) {
        EscrowRecord storage rec = escrows[escrowId];
        return (
            rec.state == EscrowState.Released &&
            !rec.settlementClaimed &&
            block.timestamp >= rec.claimableAfter
        );
    }

    function getSettlementClaim(bytes32 escrowId)
        external
        view
        returns (
            uint256 claimableAfter,
            uint256 fareClaimed,
            uint256 userRefundClaimed,
            uint256 operatorRefundClaimed,
            bool settlementClaimed
        )
    {
        EscrowRecord storage rec = escrows[escrowId];

        return (
            rec.claimableAfter,
            rec.fareClaimed,
            rec.userRefundClaimed,
            rec.operatorRefundClaimed,
            rec.settlementClaimed
        );
    }

    function getRawEscrow(bytes32 escrowId)
        external
        view
        returns (
            address user,
            address operator,
            uint256 userDepositAmount,
            uint256 operatorDepositAmount,
            uint256 fareAmount,
            uint256 holdDeadline,
            bool penalizeOperator,
            EscrowState state
        )
    {
        EscrowRecord storage rec = escrows[escrowId];

        return (
            rec.user,
            rec.operator,
            rec.userDeposit,
            rec.operatorDeposit,
            rec.fareAmount,
            rec.holdDeadline,
            rec.penalizeOperator,
            rec.state
        );
    }

    // -------------------------------------------------------------------------
    // Internal transfer helpers
    // -------------------------------------------------------------------------
    /**
     * @dev refundFare is the fare the backend has decided the operator is entitled to.
     *      The backend passes 0 for full-refund cases and the confirmed fare for partial cases.
     *
     *      Cash-flow:
     *        fareToOperator = refundFare
     *        userRefund     = totalUserFunds - refundFare
     *                         where totalUserFunds = userDeposit (pre-reservation)
     *                                              = fareClaimed + userRefundClaimed (post-reservation)
     *        operatorRefund = operatorDeposit (always returned to operator)
     */
    function _executeRefundToBuyer(
        bytes32 escrowId,
        EscrowRecord storage rec,
        uint256 refundFare
    ) internal {
        address user = rec.user;
        address operator = rec.operator;

        uint256 fareToOperator = refundFare;
        uint256 userRefund;
        uint256 operatorRefund = rec.operatorDeposit;

        if (rec.claimableAfter > 0) {
            // Dispute after settlement reservation.
            // Total user funds in contract = fareClaimed + userRefundClaimed.
            uint256 totalUserFunds = rec.fareClaimed + rec.userRefundClaimed;
            userRefund = totalUserFunds - refundFare;
        } else {
            // Dispute before settlement reservation.
            // All user funds are still held as userDeposit.
            userRefund = rec.userDeposit - refundFare;
        }

        rec.state = EscrowState.Refunded;
        rec.fareClaimed = 0;
        rec.userRefundClaimed = 0;
        rec.operatorRefundClaimed = 0;
        rec.settlementClaimed = true;

        if (fareToOperator > 0) {
            usdc.safeTransfer(operator, fareToOperator);
        }
        if (userRefund > 0) {
            usdc.safeTransfer(user, userRefund);
        }
        if (operatorRefund > 0) {
            usdc.safeTransfer(operator, operatorRefund);
        }

        emit RefundedToBuyer(escrowId, user, userRefund, 0);
    }

    function _executeForceRefund(
        bytes32 escrowId,
        EscrowRecord storage rec
    ) internal {
        uint256 userRefund = rec.userDeposit;
        uint256 operatorRefund = rec.operatorDeposit;

        address user = rec.user;
        address operator = rec.operator;

        rec.state = EscrowState.Refunded;
        rec.settlementClaimed = true;

        if (userRefund > 0) {
            usdc.safeTransfer(user, userRefund);
        }
        if (operatorRefund > 0) {
            usdc.safeTransfer(operator, operatorRefund);
        }

        emit RefundedToBuyer(escrowId, user, userRefund, 0);
    }
}

