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
  userAddress:   ethAddress().required(),
  serviceType:   Joi.string().valid('bicycle', 'ev_charging', 'parking').required(),
  depositUsdc:   usdcAmount(),
  depositTxHash: Joi.string().optional(),  // 레거시 호환 — 실제 처리는 /deposit 엔드포인트
  meta:          Joi.object().optional(),
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
  userFinalSig: Joi.string().optional().default(''), // 오프체인 서명 (없어도 정산 가능)
  fareUsdc:     Joi.string().optional(),   // charge에서 받은 요금 직접 전달
  adjustment:   Joi.object({ creditUsdc: usdcAmount() }).optional(),
});

router.post('/:id/end', validate(endSchema), async (req, res, next) => {
  try {
    // ── 세션 존재 여부 사전 검증 ──────────────────────────────────────────────
    const _db = require('../services/db');
    const _sess = await _db.getPool().query(
      `SELECT id, status FROM sessions WHERE id = $1`, [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!_sess.rows[0]) {
      return res.status(404).json({ ok: false, error: `Session not found: ${req.params.id}` });
    }
    // ──────────────────────────────────────────────────────────────────────────

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
    const { channelId, userAddress, operatorAddress, depositUsdc, holdDeadline, depositTxHash, serviceStartedAt } = req.body;

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

    // 1-b) 실제 서비스 시작 시점(deposit 완료 시각) → DB + Redis 캐시 동기화
    if (serviceStartedAt) {
      const db      = require('../services/db');
      const sessMgr = require('../services/sessionManager');
      // DB 업데이트
      await db.getPool().query(
        `UPDATE sessions SET started_at = to_timestamp($1 / 1000.0) WHERE id = $2`,
        [Number(serviceStartedAt), req.params.id]
      ).catch(() => {});
      // Redis 캐시 갱신 — getSession이 캐시 우선이므로 반드시 동기화
      try {
        const redis = require('../services/redisClient').getRedis();
        if (redis) {
          const SESSION_KEY = (id) => `session:${id}`;
          const raw = await redis.get(SESSION_KEY(req.params.id));
          if (raw) {
            const cached = JSON.parse(raw);
            cached.startedAt = Number(serviceStartedAt);
            await redis.set(SESSION_KEY(req.params.id), JSON.stringify(cached), 'EX', 86400);
          }
        }
      } catch(redisErr) {
        require('../utils/logger').warn('Redis cache update failed (non-fatal)', { error: redisErr.message });
      }
    }

    // 2) operator 보증금 자동 예치
    // ★ await로 처리: Railway는 비동기 .then이 요청 완료 후 실행 보장 안 됨
    // userDepositTxHash가 실제 TX인 경우만 온체인 operatorDeposit 실행
    const canEscrow = process.env.ESCROW_CONTRACT_ADDRESS && process.env.OPERATOR_PRIVATE_KEY;
    const isRealTx  = depositTxHash && !depositTxHash.startsWith('0xmock') && !depositTxHash.startsWith('0xtest');

    let operatorDepositResult = null;
    if (canEscrow && isRealTx) {
      // ★ operatorDeposit = userDeposit 금액과 동일하게
      const opDepositUsdc = depositUsdc || process.env.OPERATOR_DEPOSIT_USDC || '3.0';
      try {
        operatorDepositResult = await escrowSvc.operatorDeposit(req.params.id, opDepositUsdc, depositTxHash);
        const logger = require('../utils/logger');
        logger.info('Operator deposit complete', { sessionId: req.params.id, result: JSON.stringify(operatorDepositResult) });
      } catch(err) {
        const logger = require('../utils/logger');
        logger.error('Operator deposit failed', { sessionId: req.params.id, error: err.message });
        return next(err);
      }
    } else if (canEscrow && !isRealTx) {
      const logger = require('../utils/logger');
      logger.info('Mock TX detected — skip operatorDeposit', { sessionId: req.params.id, depositTxHash });
    }

    res.json({ ok: true, data: { ...result, operatorDeposit: operatorDepositResult } });
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

// ── GET /sessions/:id/escrow-status — 온체인 escrow 상태 polling ──────────────
// 프론트에서 /end 호출 후 settle 완료 여부를 주기적으로 확인
router.get('/:id/escrow-status', async (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const db = require('../services/db');

    // DB 상태
    const row = await db.getPool().query(
      `SELECT el.state, el.fare_amount, el.user_deposit, el.operator_deposit,
              el.settle_tx, el.settled_at, el.hold_deadline
       FROM escrow_locks el WHERE el.session_id = $1`,
      [sessionId]
    ).then(r => r.rows[0]);

    if (!row) {
      return res.json({ ok: true, data: { found: false, state: 'no_record' } });
    }

    // 온체인 상태 (환경변수 있을 때만)
    let onchain = null;
    if (process.env.ESCROW_CONTRACT_ADDRESS && (process.env.BASE_RPC_URL || process.env.BASE_SEPOLIA_RPC)) {
      try {
        const { ethers } = require('ethers');
        const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://sepolia.base.org');
        const ESCROW_ABI = ['function getEscrowStatus(bytes32) view returns (uint8,uint256,uint256,uint256,address,address,uint256,bool,bool)'];
        const escrow = new ethers.Contract(process.env.ESCROW_CONTRACT_ADDRESS, ESCROW_ABI, provider);
        const escrowId = ethers.keccak256(ethers.toUtf8Bytes(sessionId));
        const s = await escrow.getEscrowStatus(escrowId);
        const STATE = ['None','UserDeposited','FullyFunded','RefundIssue','Released','Refunded'];
        onchain = {
          state:        STATE[Number(s[0])],
          userDeposit:  ethers.formatUnits(s[1], 6),
          opDeposit:    ethers.formatUnits(s[2], 6),
          holdDeadline: Number(s[6]),
          dlPassed:     Boolean(s[8]),
        };
      } catch(e) {}
    }

    const fareUsdc   = parseFloat(row.fare_amount || 0);
    const userDep    = parseFloat(row.user_deposit || 0);
    const refundUsdc = (userDep - fareUsdc).toFixed(6);
    const settled    = row.state === 'Released' || onchain?.state === 'Released';

    res.json({
      ok: true,
      data: {
        found:      true,
        dbState:    row.state,
        onchain,
        fareUsdc:   fareUsdc.toFixed(6),
        refundUsdc,
        userDeposit: String(userDep),
        settleTx:   row.settle_tx,
        settledAt:  row.settled_at,
        settled,
      }
    });
  } catch(err) { next(err); }
});

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


// ── GET /sessions — 세션 목록 (결제 내역) ─────────────────────────────────────
// Query params:
//   userAddress (required) — 해당 지갑 주소의 세션만
//   status      (optional) — Active|Ended|Settling|Settled|Disputed
//   limit       (optional) — 기본 20, 최대 100
//   offset      (optional) — 페이지네이션
router.get('/', async (req, res, next) => {
  try {
    const { userAddress, status, limit = '20', offset = '0' } = req.query;
    if (!userAddress) return res.status(400).json({ ok: false, error: 'userAddress required' });

    const db = require('../services/db');
    const lim = Math.min(parseInt(limit) || 20, 100);
    const off = parseInt(offset) || 0;

    // sessions + escrow_locks 조인으로 결제 정보 통합
    const conditions = ['s.user_address = $1'];
    const params     = [userAddress.toLowerCase()];
    let   pidx       = 2;

    if (status) {
      conditions.push(`s.status = $${pidx++}`);
      params.push(status);
    }

    const where = conditions.join(' AND ');

    const { rows } = await db.getPool().query(
      `SELECT
         s.id,
         s.user_address,
         s.service_type,
         s.channel_id,
         s.status,
         s.deposit_usdc,
         s.charged_usdc,
         s.started_at,
         s.ended_at,
         s.settled_at,
         el.state         AS escrow_state,
         el.fare_amount   AS fare_usdc,
         el.user_deposit,
         el.settle_tx     AS tx_hash,
         el.hold_deadline,
         -- 환불 금액 계산
         CASE
           WHEN el.user_deposit IS NOT NULL AND el.fare_amount IS NOT NULL
           THEN (el.user_deposit - el.fare_amount)
           ELSE 0
         END              AS refund_usdc
       FROM sessions s
       LEFT JOIN escrow_locks el ON el.session_id = s.id
       WHERE ${where}
       ORDER BY s.started_at DESC
       LIMIT $${pidx} OFFSET $${pidx + 1}`,
      [...params, lim, off]
    );

    // 서비스 타입 한글 라벨 매핑
    const SERVICE_LABELS = {
      bicycle:     { label: '공유 자전거', emoji: '🚲' },
      ev_charging: { label: 'EV 충전',     emoji: '⚡' },
      parking:     { label: '주차',         emoji: '🅿️' },
    };

    const sessions = rows.map(r => ({
      id:           r.id,
      serviceType:  r.service_type,
      serviceLabel: SERVICE_LABELS[r.service_type]?.label || r.service_type,
      serviceEmoji: SERVICE_LABELS[r.service_type]?.emoji || '📦',
      status:       r.status,
      escrowState:  r.escrow_state,
      depositUsdc:  r.deposit_usdc ? parseFloat(r.deposit_usdc).toFixed(2) : '0.00',
      chargedUsdc:  r.charged_usdc ? parseFloat(r.charged_usdc).toFixed(6) : '0.000000',
      fareUsdc:     r.fare_usdc    ? parseFloat(r.fare_usdc).toFixed(6)    : null,
      refundUsdc:   r.refund_usdc  ? parseFloat(r.refund_usdc).toFixed(6)  : null,
      txHash:       r.tx_hash,
      startedAt:    r.started_at,
      endedAt:      r.ended_at,
      settledAt:    r.settled_at,
      holdDeadline: r.hold_deadline ? Number(r.hold_deadline) : null,
    }));

    // 전체 건수
    const { rows: countRows } = await db.getPool().query(
      `SELECT COUNT(*) AS total FROM sessions s WHERE ${where}`,
      params
    );

    res.json({
      ok:    true,
      data:  sessions,
      total: parseInt(countRows[0].total),
      limit: lim,
      offset: off,
    });
  } catch (err) { next(err); }
});


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

// ── GET /sessions/:id — 개별 세션 조회 ──────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const db = require('../services/db');
    const { rows } = await db.getPool().query(
      `SELECT s.*, el.state as escrow_state, el.fare_amount as fare_usdc,
              el.user_deposit, el.settle_tx as tx_hash, el.hold_deadline,
              CASE WHEN el.user_deposit IS NOT NULL AND el.fare_amount IS NOT NULL
                   THEN (el.user_deposit - el.fare_amount) ELSE 0 END as refund_usdc
       FROM sessions s
       LEFT JOIN escrow_locks el ON el.session_id = s.id
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ ok: false, error: 'Session not found' });
    res.json({ ok: true, data: rows[0] });
  } catch (err) { next(err); }
});

// ── GET /sessions/debug/count — DB 직접 카운트 (배포 진단용) ─────────────────
router.get('/debug/count', async (req, res, next) => {
  try {
    const db = require('../services/db');
    const { rows } = await db.getPool().query(
      `SELECT COUNT(*) as total, MAX(created_at) as latest FROM sessions`
    );
    const recent = await db.getPool().query(
      `SELECT id, user_address, status, started_at, created_at FROM sessions ORDER BY created_at DESC LIMIT 5`
    );
    res.json({ ok: true, total: rows[0].total, latest: rows[0].latest, recent: recent.rows });
  } catch (err) { next(err); }
});

module.exports = router;


