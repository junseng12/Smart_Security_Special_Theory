const DISPLAY_STATUS = Object.freeze({
  ACTIVE: 'ACTIVE',
  SETTLING: 'SETTLING',
  COMPLETED: 'COMPLETED',
  REFUNDED: 'REFUNDED',
  NEEDS_ATTENTION: 'NEEDS_ATTENTION',
});

function deriveDisplayStatus({ sessionStatus, escrowState, txStatus, startedAt }) {
  // Final on-chain states are authoritative.
  if (escrowState === 'Refunded') return DISPLAY_STATUS.REFUNDED;
  if (escrowState === 'Released') return DISPLAY_STATUS.COMPLETED;

  if (
    ['SettleFailed', 'RefundIssue'].includes(escrowState)
    || ['Disputed', 'ForceClosed'].includes(sessionStatus)
    || ['REVERTED', 'NEEDS_REVIEW'].includes(txStatus)
  ) {
    return DISPLAY_STATUS.NEEDS_ATTENTION;
  }

  if (
    ['Ended', 'Settling'].includes(sessionStatus)
    || escrowState === 'PendingSettle'
    || ['QUEUED', 'SUBMITTED'].includes(txStatus)
  ) {
    return DISPLAY_STATUS.SETTLING;
  }

  // DB의 Settled 값만으로 완료 처리하지 않는다. Released/Refunded 온체인 상태가
  // 확인되지 않은 완료 레코드는 운영자가 확인해야 한다.
  if (sessionStatus === 'Settled') return DISPLAY_STATUS.NEEDS_ATTENTION;

  if (sessionStatus === 'Active') {
    const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
    const stale = Number.isFinite(startMs) && Date.now() - startMs > 5 * 60 * 60 * 1000;
    if (stale || (escrowState && escrowState !== 'FullyFunded')) {
      return DISPLAY_STATUS.NEEDS_ATTENTION;
    }
    return DISPLAY_STATUS.ACTIVE;
  }

  return DISPLAY_STATUS.NEEDS_ATTENTION;
}

module.exports = { DISPLAY_STATUS, deriveDisplayStatus };
