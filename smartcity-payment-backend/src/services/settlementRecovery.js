'use strict';

const DEFAULT_FORCE_REFUND_GRACE_MS = 60 * 60 * 1000;

function recoveryAction({ perunProof, holdDeadline, nowMs = Date.now(), forceRefundGraceMs = DEFAULT_FORCE_REFUND_GRACE_MS }) {
  if (perunProof) return 'settle';
  if (!holdDeadline) return 'wait';
  const deadlineMs = new Date(holdDeadline).getTime();
  if (!Number.isFinite(deadlineMs)) return 'wait';
  return nowMs >= deadlineMs + forceRefundGraceMs ? 'refund' : 'wait';
}

module.exports = { recoveryAction, DEFAULT_FORCE_REFUND_GRACE_MS };
