/**
 * Session Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/sessions/start        세션 + 채널 오픈
 * POST /api/v1/sessions/:id/charge   사용량 기반 요금 청구
 * POST /api/v1/sessions/:id/sign     사용자 서명 제출
 * POST /api/v1/sessions/:id/end      세션 종료 + 정산
 * GET  /api/v1/sessions/:id/status   세션 상태 조회
 * GET  /api/v1/sessions/:id/stream   SSE 실시간 이벤트
 */

const { Router } = require('express');
const Joi = require('joi');
const orchestrator = require('../services/channelOrchestrator');
const sigMgr = require('../services/signatureManager');
const sessionMgr = require('../services/sessionManager');
const { isValidAddress } = require('../services/walletService');
const { getSettlement } = require('../services/settlementManager');
const escrowSvc = require('../services/escrowPayoutService');
const sseClients = require('../utils/sseClients');
const logger = require('../utils/logger');

const router = Router();

// ── Validation helpers ────────────────────────────────────────────────────────
const ethAddress = () =>
  Joi.string().custom((val, helpers) =>
    isValidAddress(val) ? val : helpers.error('any.invalid'), 'Ethereum address');

const usdcAmount = () =>
  Joi.string().pattern(/^\d+(\.\d{1,6})?$/).required();

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false });
    if (error) return res.status(400).json({ ok: false, errors: error.details.map((d) => d.message) });
    req.body = value;
    next();
  };
}

// ── POST /sessions/start ──────────────────────────────────────────────────────
const startSchema = Joi.object({
  userAddress:  ethAddress().required(),
  serviceType:  Joi.string().valid('bicycle', 'ev_charging', 'parking').required(),
  depositUsdc:  usdcAmount(),
  meta:         Joi.object().optional(),
});

router.post('/start', validate(startSchema), async (req, res, next) => {
  try {
    const result = await orchestrator.startSessionAndOpenChannel(req.body);
    res.status(201).json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ── POST /sessions/:id/charge ─────────────────────────────────────────────────
const chargeSchema = Joi.object({
  channelId:   Joi.string().required(),
  userAddress: ethAddress().required(),
  serviceType: Joi.string().valid('bicycle', 'ev_charging', 'parking').required(),
  usage: Joi.object({
    durationMinutes: Joi.number().min(0),
    energyKwh:       Joi.number().min(0),
    isLate:          Joi.boolean(),
    isOverstay:      Joi.boolean(),
    overstayMinutes: Joi.number().min(0),
  }).required(),
});

router.post('/:id/charge', validate(chargeSchema), async (req, res, next) => {
  try {
    const result = await orchestrator.chargeUsage({
      sessionId: req.params.id,
      ...req.body,
    });

    // SSE 알림 — 서명 필요 (signatureRequest가 있을 때만)
    if (result.signatureRequest?.stateHash) {
      sseClients.broadcast(req.body.userAddress, {
        event: 'sign_required',
        sessionId: req.params.id,
        channelId: req.body.channelId,
        stateHash: result.signatureRequest.stateHash,
        nonce:     result.signatureRequest.nonce,
        fareUsdc:  result.fare.fareUsdc,
      });
    }

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ── POST /sessions/:id/sign ───────────────────────────────────────────────────
const signSchema = Joi.object({
  channelId:   Joi.string().required(),
  userSig:     Joi.string().required(),
  userAddress: ethAddress().required(),
});

router.post('/:id/sign', validate(signSchema), async (req, res, next) => {
  try {
    const confirmedState = await sigMgr.submitUserSignature({
      channelId:   req.body.channelId,
      userSig:     req.body.userSig,
      userAddress: req.body.userAddress,
    });

    sseClients.broadcast(req.body.userAddress, {
      event: 'state_confirmed',
      sessionId: req.params.id,
      nonce: confirmedState.nonce,
      balances: confirmedState.balances,
    });

    res.json({ ok: true, data: confirmedState });
  } catch (err) { next(err); }
});

// ── POST /sessions/:id/end ────────────────────────────────────────────────────
const endSchema = Joi.object({
  channelId:    Joi.string().required(),
  userAddress:  ethAddress().required(),
  userFinalSig: Joi.string().required(),
  fareUsdc:     Joi.string().optional(),   // charge에서 받은 요금 직접 전달
  adjustment:   Joi.object({ creditUsdc: usdcAmount() }).optional(),
});

router.post('/:id/end', validate(endSchema), async (req, res, next) => {
  try {
    const result = await orchestrator.endSessionAndSettle({
      sessionId:    req.params.id,
      channelId:    req.body.channelId,
      userAddress:  req.body.userAddress,
      userFinalSig: req.body.userFinalSig,
      fareUsdc:     req.body.fareUsdc,      // ★ charge 요금 직접 전달
      adjustment:   req.body.adjustment,
    });

    sseClients.broadcast(req.body.userAddress, {
      event: 'settlement_complete',
      sessionId: req.params.id,
      txHash: result.txHash,
    });

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ── POST /sessions/:id/deposit — 프론트 buyerDeposit 완료 후 DB 기록 ────────────
router.post('/:id/deposit', async (req, res, next) => {
  try {
    const { channelId, userAddress, operatorAddress, depositUsdc, holdDeadline, depositTxHash } = req.body;

    // 1) DB에 사용자 예치 기록
    const result = await escrowSvc.recordUserDeposit({
      sessionId:       req.params.id,
      channelId,
      userAddress,
      operatorAddress: operatorAddress || process.env.OPERATOR_ADDRESS,
      depositUsdc,
      holdDeadline,
      depositTxHash,
    });

    // 2) operator 보증금 자동 예치 (비동기 — 실패해도 세션 진행)
    const canEscrow = process.env.ESCROW_CONTRACT_ADDRESS && process.env.OPERATOR_PRIVATE_KEY;
    if (canEscrow) {
      const opDepositUsdc = process.env.OPERATOR_DEPOSIT_USDC || '1.0'; // 기본 보증금
      escrowSvc.operatorDeposit(req.params.id, opDepositUsdc).then(r => {
        // 성공 로그는 서비스 내부에서 처리
      }).catch(err => {
        const logger = require('../utils/logger');
        logger.warn('Operator deposit failed (non-fatal)', { sessionId: req.params.id, error: err.message });
      });
    }

    res.json({ ok: true, data: result });
  } catch (err) { next(err); }
});

// ── GET /sessions/:id/escrow-id — 프론트 buyerDeposit 호출 전 escrowId 조회 ─────
router.get('/:id/escrow-id', async (req, res, next) => {
  try {
    const escrowId = escrowSvc.toEscrowId(req.params.id);
    res.json({ ok: true, data: { escrowId, sessionId: req.params.id } });
  } catch (err) { next(err); }
});

// ── GET /sessions/:id/status ──────────────────────────────────────────────────
router.get('/:id/status', async (req, res, next) => {
  try {
    const session = await sessionMgr.getSession(req.params.id);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    const settlement = await getSettlement(req.params.id);

    // 프론트용 단계 표시
    const stage = _deriveStage(session.status, settlement);

    res.json({ ok: true, data: { session, settlement, stage } });
  } catch (err) { next(err); }
});

function _deriveStage(status, settlement) {
  if (status === 'Active')           return 'deposit_complete';
  if (status === 'Ended')            return 'session_ended';
  if (status === 'Settling')         return 'settling';
  if (status === 'Settled')          return settlement ? 'completed' : 'settled';
  if (status === 'Disputed')         return 'disputed';
  if (status === 'ForceClosed')      return 'force_closed';
  return 'unknown';
}

// ── GET /sessions/:id/stream (SSE) ───────────────────────────────────────────
router.get('/:id/stream', async (req, res) => {
  const { userAddress } = req.query;
  if (!userAddress) return res.status(400).json({ ok: false, error: 'userAddress query param required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const clientId = sseClients.register(userAddress, res);
  logger.info('SSE client connected', { userAddress, clientId });

  // Heartbeat
  const heartbeat = setInterval(() => {
    res.write(`data: ${JSON.stringify({ event: 'heartbeat', ts: Date.now() })}\n\n`);
  }, 20_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.remove(clientId);
    logger.info('SSE client disconnected', { userAddress, clientId });
  });
});

module.exports = router;
