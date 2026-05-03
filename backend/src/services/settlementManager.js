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
async function recordSettlement({ sessionId, channelId, txHash, finalState, userAddress }) {
  await ensureSettlementTable();

  const { ethers } = require('ethers');
  const userRefundWei = BigInt(finalState.balances.user);
  const operatorEarnWei = BigInt(finalState.balances.operator);

  const userRefundUsdc = ethers.formatUnits(userRefundWei, 6);
  const operatorEarnUsdc = ethers.formatUnits(operatorEarnWei, 6);

  await getPool().query(
    `INSERT INTO settlements
     (session_id, channel_id, tx_hash, status, final_nonce, user_refund_usdc, operator_earn_usdc, final_state)
     VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7)`,
    [sessionId, channelId, txHash, finalState.nonce, userRefundUsdc, operatorEarnUsdc, JSON.stringify(finalState)]
  );

  logger.info('Settlement recorded', { sessionId, txHash, userRefundUsdc, operatorEarnUsdc });

  // TX 확인 대기 (비동기 백그라운드)
  _waitForConfirmation(sessionId, txHash).catch((err) =>
    logger.error('Settlement confirmation error', { sessionId, error: err.message })
  );

  return { userRefundUsdc, operatorEarnUsdc };
}

/**
 * TX 확인 대기 (Base RPC polling)
 */
async function _waitForConfirmation(sessionId, txHash, maxAttempts = 30) {
  const { ethers } = require('ethers');
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 5000)); // 5초마다 체크
    try {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (receipt) {
        const success = receipt.status === 1;
        await getPool().query(
          `UPDATE settlements
           SET status = $2, confirmed_at = NOW()
           WHERE session_id = $1 AND tx_hash = $3`,
          [sessionId, success ? 'confirmed' : 'failed', txHash]
        );
        logger.info('Settlement TX confirmed', { sessionId, txHash, success });
        return;
      }
    } catch (err) {
      logger.warn('TX receipt check failed', { attempt: i + 1, error: err.message });
    }
  }

  logger.error('Settlement TX confirmation timeout', { sessionId, txHash });
  await getPool().query(
    `UPDATE settlements SET status = 'failed' WHERE session_id = $1 AND tx_hash = $2`,
    [sessionId, txHash]
  );
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

module.exports = {
  recordSettlement,
  getSettlement,
};
