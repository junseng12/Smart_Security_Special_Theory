/**
 * Signature Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * 오프체인 상태 업데이트 생성 + 사용자 서명 요청/수신/검증
 *
 * 서명 요청은 Redis에 pending으로 저장 → SSE로 프론트에 푸시
 * 사용자가 서명 제출 시 검증 후 최신 상태 확정
 */

const logger = require('../utils/logger');
const { getRedis, saveChannelState, getChannelState } = require('./redisClient');
const { operatorSignState, verifyUserSignature } = require('./walletService');
const { getPool } = require('./db');

// ── 서명 요청 저장 키 ─────────────────────────────────────────────────────────
const SIG_REQUEST_KEY = (channelId) => `sigreq:${channelId}`;
const SIG_REQUEST_TTL = 60 * 5; // 5분 내 서명 안 하면 재요청

// ── DB 마이그레이션 ────────────────────────────────────────────────────────────
async function ensureSignatureTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS signature_requests (
      id            SERIAL PRIMARY KEY,
      channel_id    TEXT NOT NULL,
      session_id    TEXT,
      nonce         BIGINT NOT NULL,
      state_hash    TEXT NOT NULL,
      charge_usdc   NUMERIC,
      status        TEXT NOT NULL DEFAULT 'pending', -- pending | signed | expired | failed
      user_sig      TEXT,
      operator_sig  TEXT,
      requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      signed_at     TIMESTAMPTZ,
      retry_count   INT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sigreq_channel ON signature_requests(channel_id);
  `);
}

// ── 서명 요청 생성 ────────────────────────────────────────────────────────────

/**
 * 새로운 오프체인 상태를 만들고 사용자 서명 요청을 발행한다.
 *
 * @param {object} params
 * @param {string} params.channelId
 * @param {string} params.sessionId
 * @param {string} params.chargeUsdc   - 이번 업데이트로 청구할 금액
 * @param {string} params.userAddress
 *
 * @returns {{ requestId, nonce, newBalances, stateHash }}
 */
async function createSignatureRequest({ channelId, sessionId, chargeUsdc, userAddress }) {
  await ensureSignatureTable();

  const current = await getChannelState(channelId);
  if (!current) throw new Error(`Channel ${channelId} state not found in Redis`);

  const { ethers } = require('ethers');
  const chargeWei = ethers.parseUnits(chargeUsdc, 6);
  const curUser = BigInt(current.balances.user);
  const curOp   = BigInt(current.balances.operator);

  if (chargeWei > curUser) throw new Error('Charge exceeds user channel balance');

  const newUserBalance = (curUser - chargeWei).toString();
  const newOpBalance   = (curOp + chargeWei).toString();
  const newNonce       = current.nonce + 1;

  // state hash (operator가 미리 서명해둠 → 사용자가 확인 후 서명)
  const { buildStateMessage } = require('./walletService');
  const stateHash = buildStateMessage(channelId, newNonce, newUserBalance, newOpBalance);
  const operatorSig = await operatorSignState(channelId, newNonce, newUserBalance, newOpBalance);

  // 서명 요청을 Redis에 저장 (pending)
  const request = {
    channelId,
    sessionId,
    nonce: newNonce,
    stateHash,
    chargeUsdc,
    newBalances: { user: newUserBalance, operator: newOpBalance },
    operatorSig,
    userAddress,
    status: 'pending',
    createdAt: Date.now(),
    retryCount: 0,
  };

  const redis = getRedis();
  await redis.set(SIG_REQUEST_KEY(channelId), JSON.stringify(request), 'EX', SIG_REQUEST_TTL);

  // DB 기록
  const result = await getPool().query(
    `INSERT INTO signature_requests
     (channel_id, session_id, nonce, state_hash, charge_usdc, operator_sig)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [channelId, sessionId, newNonce, stateHash, chargeUsdc, operatorSig]
  );

  const requestId = result.rows[0].id;
  logger.info('Signature request created', { channelId, nonce: newNonce, chargeUsdc });

  return {
    requestId,
    nonce: newNonce,
    newBalances: { user: newUserBalance, operator: newOpBalance },
    stateHash,
    operatorSig,
  };
}

// ── 서명 수신/검증 ────────────────────────────────────────────────────────────

/**
 * 사용자가 제출한 서명을 검증하고 최신 상태를 확정한다.
 *
 * @param {object} params
 * @param {string} params.channelId
 * @param {string} params.userSig
 * @param {string} params.userAddress
 *
 * @returns {{ nonce, balances, userSig, operatorSig }}
 */
async function submitUserSignature({ channelId, userSig, userAddress }) {
  const redis = getRedis();
  const raw = await redis.get(SIG_REQUEST_KEY(channelId));
  if (!raw) throw new Error('No pending signature request or request expired');

  const request = JSON.parse(raw);

  // nonce 역행 방지
  const current = await getChannelState(channelId);
  if (request.nonce <= (current?.nonce || 0)) {
    throw new Error(`Nonce regression detected: got ${request.nonce}, current ${current?.nonce}`);
  }

  // 서명 검증
  const valid = verifyUserSignature(
    channelId,
    request.nonce,
    request.newBalances.user,
    request.newBalances.operator,
    userSig,
    userAddress
  );
  if (!valid) throw new Error('Invalid user signature');

  // 최신 상태 확정
  const confirmedState = {
    nonce: request.nonce,
    balances: request.newBalances,
    signatures: { user: userSig, operator: request.operatorSig },
    updatedAt: Date.now(),
  };

  await saveChannelState(channelId, confirmedState);

  // Redis 서명 요청 삭제
  await redis.del(SIG_REQUEST_KEY(channelId));

  // DB 업데이트
  await getPool().query(
    `UPDATE signature_requests
     SET status = 'signed', user_sig = $2, signed_at = NOW()
     WHERE channel_id = $1 AND nonce = $3`,
    [channelId, userSig, request.nonce]
  );

  logger.info('User signature accepted', { channelId, nonce: request.nonce });
  return confirmedState;
}

// ── 서명 요청 상태 조회 ────────────────────────────────────────────────────────

async function getPendingRequest(channelId) {
  const redis = getRedis();
  const raw = await redis.get(SIG_REQUEST_KEY(channelId));
  return raw ? JSON.parse(raw) : null;
}

/**
 * 만료된 요청 재발행 (Watchtower 또는 자동 retry 용)
 */
async function retrySignatureRequest(channelId) {
  const request = await getPendingRequest(channelId);
  if (!request) throw new Error('No pending request to retry');

  request.retryCount += 1;
  request.createdAt = Date.now();

  const redis = getRedis();
  await redis.set(SIG_REQUEST_KEY(channelId), JSON.stringify(request), 'EX', SIG_REQUEST_TTL);

  await getPool().query(
    `UPDATE signature_requests
     SET retry_count = retry_count + 1
     WHERE channel_id = $1 AND nonce = $2`,
    [channelId, request.nonce]
  );

  logger.info('Signature request retried', { channelId, retryCount: request.retryCount });
  return request;
}

module.exports = {
  createSignatureRequest,
  submitUserSignature,
  getPendingRequest,
  retrySignatureRequest,
};
