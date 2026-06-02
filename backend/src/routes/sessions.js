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

    // SSE 알림 — 서명 필요
    sseClients.broadcast(req.body.userAddress, {
      event: 'sign_required',
      sessionId: req.params.id,
      channelId: req.body.channelId,
      requestId: result.signatureRequest.requestId,
      stateHash: result.signatureRequest.stateHash,
      fareUsdc:  result.fare.fareUsdc,
    });

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


// ── POST /sessions/:id/deposit ────────────────────────────────────────────────
// 사용자 deposit TX 완료 후 프론트가 호출 → 백엔드가 operatorDeposit 자동 실행
const depositSchema = Joi.object({
  channelId:       Joi.string().required(),
  userAddress:     ethAddress().required(),
  operatorAddress: ethAddress().required(),
  depositUsdc:     usdcAmount(),
  holdDeadline:    Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  depositTxHash:   Joi.string().required(),
});

router.post('/:id/deposit', validate(depositSchema), async (req, res, next) => {
  try {
    const { channelId, userAddress, depositUsdc, holdDeadline, depositTxHash } = req.body;
    const sessionId = req.params.id;

    // 세션 존재 확인
    const session = await sessionMgr.getSession(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });

    // escrowId 계산 (keccak256(sessionId))
    const { ethers } = require('ethers');
    const escrowId = ethers.keccak256(ethers.toUtf8Bytes(sessionId));

    // operatorDeposit 자동 실행 (백엔드 운영자 키로)
    const operatorAddress  = process.env.OPERATOR_ADDRESS;
    const operatorPrivKey  = process.env.OPERATOR_PRIVATE_KEY;
    const rpcUrl           = process.env.BASE_RPC_URL;
    const escrowAddress    = process.env.ESCROW_CONTRACT_ADDRESS;
    const usdcAddress      = process.env.USDC_CONTRACT_ADDRESS;
    const HOLD_SECONDS     = 2 * 60; // 2분 holdDeadline

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const opWallet = new ethers.Wallet(operatorPrivKey, provider);

    const USDC_ABI   = ['function approve(address spender, uint256 amount) returns (bool)'];
    const ESCROW_ABI = [
      'function operatorDeposit(bytes32 escrowId, uint256 amount) external',
      'function settleAndRelease(bytes32 escrowId, uint256 fareAmount) external',
    ];

    const usdcContract   = new ethers.Contract(usdcAddress, USDC_ABI, opWallet);
    const escrowContract = new ethers.Contract(escrowAddress, ESCROW_ABI, opWallet);

    const depositWei = ethers.parseUnits(depositUsdc, 6);

    logger.info('operator: approve USDC for operatorDeposit', { sessionId, depositUsdc });
    const approveTx = await usdcContract.approve(escrowAddress, depositWei);
    await approveTx.wait();

    logger.info('operator: calling operatorDeposit', { sessionId, escrowId });
    const depTx = await escrowContract.operatorDeposit(escrowId, depositWei);
    const depReceipt = await depTx.wait();

    logger.info('operatorDeposit complete', { sessionId, txHash: depReceipt.hash });

    // 세션 메타 업데이트
    await sessionMgr.linkChannel(sessionId, channelId);

    res.json({ ok: true, data: {
      sessionId,
      channelId,
      escrowId,
      userDepositTx: depositTxHash,
      operatorDepositTx: depReceipt.hash,
    }});
  } catch (err) { next(err); }
});

// ── POST /sessions/:id/end ────────────────────────────────────────────────────
const endSchema = Joi.object({
  channelId:    Joi.string().required(),
  userAddress:  ethAddress().required(),
  userFinalSig: Joi.string().required(),
  adjustment:   Joi.object({ creditUsdc: usdcAmount() }).optional(),
});

router.post('/:id/end', validate(endSchema), async (req, res, next) => {
  try {
    const result = await orchestrator.endSessionAndSettle({
      sessionId: req.params.id,
      ...req.body,
    });

    sseClients.broadcast(req.body.userAddress, {
      event: 'settlement_complete',
      sessionId: req.params.id,
      txHash: result.txHash,
    });

    res.json({ ok: true, data: result });
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

