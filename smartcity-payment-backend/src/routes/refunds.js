/**
 * Refund Routes V3.2
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/refunds                       환불 케이스 생성
 * GET  /api/v1/refunds/:caseId               케이스 조회
 * POST /api/v1/refunds/:caseId/evaluate      자동 심사 실행
 * POST /api/v1/refunds/:caseId/approve       운영자 수동 승인
 * POST /api/v1/refunds/:caseId/reject        운영자 수동 거절
 * POST /api/v1/refunds/:caseId/payout        온체인 전액 환불 실행
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
// 현재 0xa264... 배포본 정책: 승인된 케이스는 사용자 예치금 전액 환불
const payoutSchema = Joi.object({
  sessionId: Joi.string().required(),
});

router.post('/:caseId/payout', validate(payoutSchema), async (req, res, next) => {
  try {
    const { caseId } = req.params;
    const { sessionId } = req.body;

    // 1) 케이스 조회
    const c = await caseMgr.getCase(caseId);
    if (!c) return res.status(404).json({ ok: false, error: 'Case not found' });
    if (c.status !== 'APPROVED') {
      return res.status(400).json({ ok: false, error: `Case must be APPROVED, current: ${c.status}` });
    }

    const { getPool } = require('../services/db');
    // 2) 세션 소유권과 예치금 확인
    const { rows } = await getPool().query(
        `SELECT s.user_address, s.deposit_usdc, e.user_deposit
         FROM sessions s
         LEFT JOIN escrow_locks e ON e.session_id = s.id
         WHERE s.id = $1 LIMIT 1`,
        [sessionId]
      );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Session not found' });
    if (c.session_id && c.session_id !== sessionId) {
      return res.status(400).json({ ok: false, error: 'Case session does not match payout session' });
    }
    if (rows[0].user_address?.toLowerCase() !== c.user_address?.toLowerCase()) {
      return res.status(403).json({ ok: false, error: 'Refund case owner does not match session owner' });
    }
    const depositUsdc = String(rows[0].user_deposit || rows[0].deposit_usdc || '0');

    logger.info('Full refund payout requested', {
      caseId, sessionId, reason: c.reason, depositUsdc, approvedUsdc: c.approved_usdc,
    });

    // 3) 실제 배포 컨트랙트의 refundToBuyer(bytes32) 실행
    const result = await escrow.refundToBuyer(sessionId, caseId);
    if (!result.confirmed) {
      return res.status(409).json({ ok: false, error: `Refund not executed: ${result.reason}` });
    }

    // 4) 온체인 Refunded 상태가 확인된 뒤에만 케이스 지급 완료 처리
    await caseMgr.markPaid(caseId);

    res.json({
      ok: true,
      data: { ...result, refundFare: '0.000000', refundUsdc: depositUsdc, depositUsdc, caseId },
    });
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

