/**
 * Settlement Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * 온체인 정산 TX 추적 + 결과 기록
 * Perun 정산 완료 후 → Escrow 컨트랙트로 자금 이동
 */

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
  getSettlement,
  getLatestSettlement,
};
