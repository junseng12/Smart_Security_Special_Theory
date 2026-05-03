/**
 * Refund Decision Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그/센서/정책 규칙 기반으로 환불액 산정
 * 자동 판단 가능 케이스 vs 수동 승인 케이스 분기
 */

const logger = require('../utils/logger');
const { getPool } = require('./db');
const caseManager = require('./refundCaseManager');
const { getLatestFareRecord } = require('./fareEngine');
const { getSettlement } = require('./settlementManager');

// ── 자동 승인 임계값 (USDC) ───────────────────────────────────────────────────
const AUTO_APPROVE_THRESHOLD_USDC = 5.0;

// ── 판단 규칙 ─────────────────────────────────────────────────────────────────

const RULES = {
  /**
   * 반납 센서 미감지: 세션 종료 이벤트와 실제 반납 이벤트 시간 차이
   */
  sensor_failure: async ({ sessionId, evidence }) => {
    const returnEvent = evidence.find((e) => e.type === 'return_event');
    const sessionEnd = evidence.find((e) => e.type === 'session_end');

    if (!returnEvent || !sessionEnd) {
      return { eligible: false, reason: 'Insufficient evidence for sensor failure' };
    }

    const fareRecord = await getLatestFareRecord(sessionId);
    if (!fareRecord) return { eligible: false, reason: 'No fare record found' };

    // 반납 이벤트 이후 과금된 금액 계산
    const overchargedMinutes = Math.max(
      0,
      (new Date(sessionEnd.timestamp) - new Date(returnEvent.timestamp)) / 60000
    );

    const policy = fareRecord.policy || {};
    const rate = parseFloat(policy.ratePerMinute || 0.01);
    const refundAmount = Math.min(overchargedMinutes * rate, parseFloat(fareRecord.final_fare));

    return {
      eligible: refundAmount > 0,
      refundUsdc: refundAmount.toFixed(6),
      reason: `Sensor failure: overcharged ${overchargedMinutes.toFixed(1)} minutes`,
    };
  },

  /**
   * 중복 청구: 같은 세션에 동일 nonce 이중 과금
   */
  double_charge: async ({ sessionId, channelId }) => {
    const result = await getPool().query(
      `SELECT nonce, COUNT(*) as cnt
       FROM channel_states
       WHERE channel_id = $1
       GROUP BY nonce HAVING COUNT(*) > 1`,
      [channelId]
    );

    if (result.rows.length === 0) {
      return { eligible: false, reason: 'No duplicate charges found' };
    }

    const fareRecord = await getLatestFareRecord(sessionId);
    const refundUsdc = fareRecord ? (parseFloat(fareRecord.final_fare) * 0.5).toFixed(6) : '0';

    return {
      eligible: true,
      refundUsdc,
      reason: `Double charge detected on nonces: ${result.rows.map((r) => r.nonce).join(', ')}`,
    };
  },

  /**
   * 서비스 장애: 운영 장애 시간대와 세션 겹침
   */
  service_outage: async ({ sessionId, evidence }) => {
    const outage = evidence.find((e) => e.type === 'outage_record');
    if (!outage) return { eligible: false, reason: 'No outage record in evidence' };

    const fareRecord = await getLatestFareRecord(sessionId);
    if (!fareRecord) return { eligible: false, reason: 'No fare record' };

    // 장애 시간과 세션 겹침 비율에 따라 환불
    const overlapMinutes = outage.overlapMinutes || 0;
    const totalMinutes = fareRecord.usage_data?.durationMinutes || 1;
    const refundRatio = Math.min(overlapMinutes / totalMinutes, 1.0);
    const refundUsdc = (parseFloat(fareRecord.final_fare) * refundRatio).toFixed(6);

    return {
      eligible: refundUsdc > 0,
      refundUsdc,
      reason: `Service outage ${overlapMinutes}min overlap out of ${totalMinutes}min session`,
    };
  },

  /**
   * 요금 오류 / 기기 결함 / 수동 요청: 운영자 수동 검토
   */
  wrong_amount:        async () => ({ eligible: null, requiresManualReview: true, reason: 'Manual review required for wrong amount' }),
  device_malfunction:  async () => ({ eligible: null, requiresManualReview: true, reason: 'Manual review required for device malfunction' }),
  manual_request:      async () => ({ eligible: null, requiresManualReview: true, reason: 'Manual review required' }),
};

// ── 판단 실행 ─────────────────────────────────────────────────────────────────

/**
 * 케이스 ID를 받아 판단 실행 → 자동 처리 or 수동 대기
 *
 * @param {string} caseId
 * @returns {{ decision: 'auto_approved'|'manual_required'|'rejected', refundUsdc?, reason }}
 */
async function evaluateCase(caseId) {
  const caseRecord = await caseManager.getCase(caseId);
  if (!caseRecord) throw new Error(`Case ${caseId} not found`);

  // 상태 → VERIFYING
  const evidence = Array.isArray(caseRecord.evidence) ? caseRecord.evidence : [];
  await caseManager.startVerifying(caseId, { type: 'evaluation_started', timestamp: new Date() });

  const rule = RULES[caseRecord.reason];
  if (!rule) {
    await caseManager.rejectCase(caseId, 'No rule defined for this reason');
    return { decision: 'rejected', reason: 'No rule defined' };
  }

  let result;
  try {
    result = await rule({
      sessionId: caseRecord.session_id,
      channelId: caseRecord.channel_id,
      userAddress: caseRecord.user_address,
      requestedUsdc: caseRecord.requested_usdc,
      evidence,
    });
  } catch (err) {
    logger.error('Rule evaluation error', { caseId, error: err.message });
    result = { eligible: null, requiresManualReview: true, reason: err.message };
  }

  // ── 수동 검토 필요 ────────────────────────────────────────────────────────
  if (result.requiresManualReview || result.eligible === null) {
    logger.info('Case requires manual review', { caseId, reason: result.reason });
    return { decision: 'manual_required', reason: result.reason };
  }

  // ── 자격 없음 ─────────────────────────────────────────────────────────────
  if (!result.eligible) {
    await caseManager.rejectCase(caseId, result.reason);
    return { decision: 'rejected', reason: result.reason };
  }

  // ── 자격 있음 → 자동/수동 승인 결정 ─────────────────────────────────────
  const refundAmount = parseFloat(result.refundUsdc);

  if (refundAmount <= AUTO_APPROVE_THRESHOLD_USDC) {
    // 소액 → 자동 승인
    await caseManager.approveCase(caseId, {
      approvedUsdc: result.refundUsdc,
      reviewerNotes: result.reason,
      autoApproved: true,
    });
    logger.info('Case auto-approved', { caseId, refundUsdc: result.refundUsdc });
    return { decision: 'auto_approved', refundUsdc: result.refundUsdc, reason: result.reason };
  } else {
    // 고액 → 운영자 수동 승인 대기
    logger.info('Case pending manual approval (high amount)', { caseId, refundUsdc: result.refundUsdc });
    return {
      decision: 'manual_required',
      estimatedRefundUsdc: result.refundUsdc,
      reason: `Amount ${result.refundUsdc} USDC exceeds auto-approve threshold`,
    };
  }
}

/**
 * 운영자 수동 승인
 */
async function manualApprove(caseId, { approvedUsdc, reviewerNotes }) {
  await caseManager.approveCase(caseId, { approvedUsdc, reviewerNotes, autoApproved: false });
  logger.info('Case manually approved', { caseId, approvedUsdc });
  return { caseId, approvedUsdc };
}

/**
 * 운영자 수동 거절
 */
async function manualReject(caseId, reviewerNotes) {
  await caseManager.rejectCase(caseId, reviewerNotes);
  return { caseId, status: 'REJECTED' };
}

module.exports = {
  evaluateCase,
  manualApprove,
  manualReject,
};
