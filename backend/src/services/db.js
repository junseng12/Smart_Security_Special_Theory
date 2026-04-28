const { Pool } = require('pg');
const logger = require('../utils/logger');

let pool;

async function connectDB() {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query('SELECT 1'); // connection test
  await runMigrations();
  logger.info('PostgreSQL connected');
  return pool;
}

function getPool() {
  if (!pool) throw new Error('DB not initialised. Call connectDB() first.');
  return pool;
}

// ── Migrations (idempotent) ──────────────────────────────────────────────────
async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id              TEXT PRIMARY KEY,
      user_address    TEXT NOT NULL,
      operator_address TEXT NOT NULL,
      deposit_usdc    NUMERIC NOT NULL,
      status          TEXT NOT NULL DEFAULT 'open',  -- open | closed | disputed
      latest_nonce    BIGINT NOT NULL DEFAULT 0,
      latest_state    JSONB,
      opened_tx       TEXT,
      settled_tx      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channel_states (
      id              SERIAL PRIMARY KEY,
      channel_id      TEXT NOT NULL REFERENCES channels(id),
      nonce           BIGINT NOT NULL,
      balance_user    NUMERIC NOT NULL,
      balance_operator NUMERIC NOT NULL,
      user_sig        TEXT,
      operator_sig    TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS refund_transactions (
      id              SERIAL PRIMARY KEY,
      channel_id      TEXT NOT NULL,
      refund_type     TEXT NOT NULL,  -- 'adjustment' | 'forced'
      amount_usdc     NUMERIC NOT NULL,
      tx_hash         TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | failed
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_channels_user ON channels(user_address);
    CREATE INDEX IF NOT EXISTS idx_channel_states_channel ON channel_states(channel_id);
  `);
  logger.info('DB migrations complete');
}

// ── Channel CRUD ─────────────────────────────────────────────────────────────

async function createChannelRecord(data) {
  const { id, userAddress, operatorAddress, depositUsdc, openedTx } = data;
  const result = await getPool().query(
    `INSERT INTO channels (id, user_address, operator_address, deposit_usdc, opened_tx)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [id, userAddress, operatorAddress, depositUsdc, openedTx]
  );
  return result.rows[0];
}

async function updateChannelStatus(channelId, status, extra = {}) {
  const fields = ['status = $2', 'updated_at = NOW()'];
  const values = [channelId, status];
  let idx = 3;

  if (extra.settledTx) { fields.push(`settled_tx = $${idx++}`); values.push(extra.settledTx); }
  if (extra.latestNonce !== undefined) { fields.push(`latest_nonce = $${idx++}`); values.push(extra.latestNonce); }
  if (extra.latestState) { fields.push(`latest_state = $${idx++}`); values.push(JSON.stringify(extra.latestState)); }

  const result = await getPool().query(
    `UPDATE channels SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  return result.rows[0];
}

async function getChannelRecord(channelId) {
  const result = await getPool().query('SELECT * FROM channels WHERE id = $1', [channelId]);
  return result.rows[0] || null;
}

async function saveStateHistory(channelId, state) {
  await getPool().query(
    `INSERT INTO channel_states (channel_id, nonce, balance_user, balance_operator, user_sig, operator_sig)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [channelId, state.nonce, state.balances.user, state.balances.operator, state.signatures?.user, state.signatures?.operator]
  );
}

async function saveRefundRecord(data) {
  const { channelId, refundType, amountUsdc } = data;
  const result = await getPool().query(
    `INSERT INTO refund_transactions (channel_id, refund_type, amount_usdc) VALUES ($1, $2, $3) RETURNING *`,
    [channelId, refundType, amountUsdc]
  );
  return result.rows[0];
}

async function updateRefundRecord(id, txHash, status) {
  await getPool().query(
    'UPDATE refund_transactions SET tx_hash = $2, status = $3 WHERE id = $1',
    [id, txHash, status]
  );
}

module.exports = {
  connectDB,
  getPool,
  createChannelRecord,
  updateChannelStatus,
  getChannelRecord,
  saveStateHistory,
  saveRefundRecord,
  updateRefundRecord,
};
