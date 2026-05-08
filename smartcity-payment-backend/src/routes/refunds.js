/**
 * Refund Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/refunds                      환불 케이스 생성
 * GET  /api/v1/refunds/:caseId              케이스 조회
 * POST /api/v1/refunds/:caseId/evaluate     자동 판단 실행
 * POST /api/v1/refunds/:caseId/approve      운영자 수동 승인
 * POST /api/v1/refunds/:caseId/reject       운영자 수동 거절
 * POST /api/v1/refunds/:caseId/payout       환불 지급 실행 (Escrow → 사용자)
 * GET  /api/v1/refunds                      케이스 목록
 */

const { Router } = require('express');
const Joi = require('joi');
const caseMgr = require('../services/refundCaseManager');
const decisionEngine = require('../services/refundDecisionEngine');
const escrow = require('../services/escrowPayoutService');
const { isValidAddress } = require('../services/walletService');

const router = Router();

// ── Validation helpers ────────────────────────────────────────────────────────
const ethAddress = () =>
  Joi.string().custom((val, helpers) =>
    isValidAddress(val) ? val : helpers.error('any.invalid'), 'Ethereum address');

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false });
    if (error) return res.status(400).json({ ok: false, errors: error.details.map((d) => d.message) });
    req.body = value;
    next();
  };
}

// ── POST /refunds ─────────────────────────────────────────────────────────────
const createSchema = Joi.object({
  userAddress:    ethAddress().required(),
  sessionId:      Joi.string().optional(),
  channelId:      Joi.string().optional(),
  reason:         Joi.string().valid(
    'sensor_failure', 'double_charge', 'service_outage',
    'wrong_amount', 'device_malfunction', 'manual_request'
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
  reviewerNotes: Joi.string().optional(),
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
const payoutSchema = Joi.object({
  sessionId: Joi.string().required(),
});

router.post('/:caseId/payout', validate(payoutSchema), async (req, res, next) => {
  try {
    const c = await caseMgr.getCase(req.params.caseId);
    if (!c) return res.status(404).json({ ok: false, error: 'Case not found' });
    if (c.status !== 'APPROVED') {
      return res.status(400).json({ ok: false, error: `Case must be APPROVED, current: ${c.status}` });
    }

    const result = await escrow.refundToBuyer(req.body.sessionId, req.params.caseId);
    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ── GET /refunds ──────────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const cases = await caseMgr.listCases({
      userAddress: req.query.userAddress,
      status: req.query.status,
      limit: parseInt(req.query.limit) || 20,
    });
    res.json({ ok: true, data: cases });
  } catch (err) { next(err); }
});

module.exports = router;
