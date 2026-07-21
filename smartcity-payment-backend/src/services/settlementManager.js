/**
 * Settlement Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * 온체인 정산 TX 추적 + 결과 기록
 * Perun 정산 완료 후 → Escrow 컨트랙트로 자금 이동
 */

const logger = require('../utils/logger');
const { getPool } = require('./db');

// ── DB 마이그레이션 ────────────────────────────────────────────────────────────
async function ensureSettlementTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS settlements (
      id              SERIAL PRIMARY KEY,
      session_id      TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      tx_hash         TEXT,
      status          TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | failed
      final_nonce     BIGINT,
      user_refund_usdc NUMERIC,
      operator_earn_usdc NUMERIC,
      final_state     JSONB,
      confirmed_at    TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_settlements_session ON settlements(session_id);
  `);
}

// ── 정산 기록 ─────────────────────────────────────────────────────────────────

/**
 * 정산 결과 저장
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.channelId
 * @param {string} params.txHash
 * @param {object} params.finalState  - { nonce, balances: { user, operator }, ... }
 * @param {string} params.userAddress
 */
async function recordSettlement({
  sessionId,
  channelId,
  txHash,
  finalState,
  userAddress,
  fareUsdc,
  refundUsdc,
  confirmed = false,
}) {
  await ensureSettlementTable();

  // go-perun 모드: fareUsdc / refundUsdc 직접 전달
  // 레거시 모드: finalState.balances에서 계산
  let userRefundUsdc, operatorEarnUsdc, finalNonce;
  if (fareUsdc !== undefined || refundUsdc !== undefined) {
    operatorEarnUsdc = String(fareUsdc   || '0');
    userRefundUsdc   = String(refundUsdc || '0');
    finalNonce       = 0;
    finalState       = finalState || {};
  } else {
    const { ethers } = require('ethers');
    const userRefundWei    = BigInt(finalState.balances.user);
    const operatorEarnWei  = BigInt(finalState.balances.operator);
    userRefundUsdc   = ethers.formatUnits(userRefundWei,   6);
    operatorEarnUsdc = ethers.formatUnits(operatorEarnWei, 6);
    finalNonce       = finalState.nonce;
  }

  await getPool().query(
    `INSERT INTO settlements
     (session_id, channel_id, tx_hash, status, final_nonce, user_refund_usdc,
      operator_earn_usdc, final_state, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $4='confirmed' THEN NOW() ELSE NULL END)`,
    [
      sessionId,
      channelId,
      txHash,
      confirmed ? 'confirmed' : 'pending',
      finalNonce,
      userRefundUsdc,
      operatorEarnUsdc,
      JSON.stringify(finalState),
    ]
  );

  logger.info('Settlement recorded', {
    sessionId,
    txHash,
    status: confirmed ? 'confirmed' : 'pending',
    userRefundUsdc,
    operatorEarnUsdc,
  });

  return { userRefundUsdc, operatorEarnUsdc };
}

/**
 * 세션의 정산 결과 조회
 */
async function getSettlement(sessionId) {
  await ensureSettlementTable();
  const result = await getPool().query(
    'SELECT * FROM settlements WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1',
    [sessionId]
  );
  return result.rows[0] || null;
}

const getLatestSettlement = getSettlement;

module.exports = {
  recordSettlement,
  getSettlement,
  getLatestSettlement,
};
