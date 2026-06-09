/**
 * Refund Routes V3.2
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/refunds                       환불 케이스 생성
 * GET  /api/v1/refunds/:caseId               케이스 조회
 * POST /api/v1/refunds/:caseId/evaluate      자동 심사 실행
 * POST /api/v1/refunds/:caseId/approve       운영자 수동 승인
 * POST /api/v1/refunds/:caseId/reject        운영자 수동 거절
 * POST /api/v1/refunds/:caseId/payout        온체인 환불 실행 (V3.2 calcRefundFare 적용)
 * GET  /api/v1/refunds                       케이스 목록
 */

const { Router } = require('express');
const Joi = require('joi');
const caseMgr  = require('../services/refundCaseManager');
const decisionEngine = require('../services/refundDecisionEngine');
const escrow   = require('../services/escrowPayoutService');
const { isValidAddress } = require('../services/walletService');
const logger   = require('../utils/logger');

const router = Router();

// ── Validation helpers ────────────────────────────────────────────────────────
const ethAddress = () =>
  Joi.string().custom((val, helpers) =>
    isValidAddress(val) ? val : helpers.error('any.invalid'), 'Ethereum address');

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false });
    if (error) return res.status(400).json({ ok: false, errors: error.details.map(d => d.message) });
    req.body = value;
    next();
  };
}

// ── POST /refunds ─────────────────────────────────────────────────────────────
const createSchema = Joi.object({
  userAddress:    ethAddress().required(),
  sessionId:      Joi.string().optional().allow(''),
  channelId:      Joi.string().optional().allow(''),
  reason:         Joi.string().valid(
    'unlock_failure', 'sensor_failure', 'double_charge', 'service_outage',
    'wrong_amount', 'device_malfunction', 'device_fault', 'wrong_charge', 'manual_request'
  ).required(),
  requestedUsdc:  Joi.string().pattern(/^\d+(\.\d{1,6})?$/).optional(),
  evidence:       Joi.array().items(Joi.object()).optional(),
});

router.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const result = await caseMgr.createCase(req.body);
    res.status(201).json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ── GET /refunds/:caseId ──────────────────────────────────────────────────────
router.get('/:caseId', async (req, res, next) => {
  try {
    const c = await caseMgr.getCase(req.params.caseId);
    if (!c) return res.status(404).json({ ok: false, error: 'Case not found' });
    res.json({ ok: true, data: c });
  } catch (err) { next(err); }
});

// ── POST /refunds/:caseId/evaluate ────────────────────────────────────────────
router.post('/:caseId/evaluate', async (req, res, next) => {
  try {
    const decision = await decisionEngine.evaluateCase(req.params.caseId);
    res.json({ ok: true, data: decision });
  } catch (err) { next(err); }
});

// ── POST /refunds/:caseId/approve ─────────────────────────────────────────────
const approveSchema = Joi.object({
  approvedUsdc:  Joi.string().pattern(/^\d+(\.\d{1,6})?$/).required(),
  reviewerNotes: Joi.string().optional().allow(''),
});

router.post('/:caseId/approve', validate(approveSchema), async (req, res, next) => {
  try {
    const result = await decisionEngine.manualApprove(req.params.caseId, req.body);
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ── POST /refunds/:caseId/reject ──────────────────────────────────────────────
const rejectSchema = Joi.object({
  reviewerNotes: Joi.string().required(),
});

router.post('/:caseId/reject', validate(rejectSchema), async (req, res, next) => {
  try {
    const result = await decisionEngine.manualReject(req.params.caseId, req.body.reviewerNotes);
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ── POST /refunds/:caseId/payout ──────────────────────────────────────────────
// V3.2: calcRefundFare() 기반 온체인 환불 실행
// body: { sessionId }  — 승인된 케이스에 대한 에스크로 refundToBuyer 호출
const payoutSchema = Joi.object({
  sessionId:          Joi.string().required(),
  confirmedUsageFare: Joi.string().pattern(/^\d+(\.\d{1,6})?$/).optional(), // 수동 지정 시
});

router.post('/:caseId/payout', validate(payoutSchema), async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const { sessionId, confirmedUsageFare } = req.body;

    // 1) 케이스 조회
    const c = await caseMgr.getCase(caseId);
    if (!c) return res.status(404).json({ ok: false, error: 'Case not found' });
    if (c.status !== 'APPROVED') {
      return res.status(400).json({ ok: false, error: `Case must be APPROVED, current: ${c.status}` });
    }

    // 2) V3.2: calcRefundFare로 issueType별 운영자 지급 fare 계산
    //    approved_usdc = 사용자에게 돌려줄 금액 (환불액)
    //    refundFare = 운영자에게 지급할 금액 = depositUsdc - approved_usdc
    // 에스크로 잠긴 금액 조회
    let depositUsdc = '3.0'; // 기본값
    try {
      const { getPool } = require('../services/db');
      const { rows } = await getPool().query(
        'SELECT user_deposit FROM escrow_locks WHERE session_id=$1 LIMIT 1',
        [sessionId]
      );
      if (rows[0]?.user_deposit) depositUsdc = rows[0].user_deposit;
    } catch {}

    // refundFare = issueType 기반 자동 계산 (또는 수동 지정)
    const refundFare = confirmedUsageFare ||
      decisionEngine.calcRefundFare(c.reason, '0', depositUsdc);

    logger.info('Refund payout V3.2', {
      caseId, sessionId, reason: c.reason,
      depositUsdc, refundFare, approvedUsdc: c.approved_usdc
    });

    // 3) 온체인 refundToBuyer 실행
    const result = await escrow.refundToBuyer(sessionId, caseId, refundFare);

    res.json({ ok: true, data: { ...result, refundFare, caseId } });
  } catch (err) { next(err); }
});

// ── GET /refunds ──────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const cases = await caseMgr.listCases({
      userAddress: req.query.userAddress,
      status:      req.query.status,
      limit:       parseInt(req.query.limit) || 20,
    });
    res.json({ ok: true, data: cases });
  } catch (err) { next(err); }
});

module.exports = router;
