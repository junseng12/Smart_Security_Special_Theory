const { Pool } = require('pg');
const logger = require('../utils/logger');

let pool;

async function connectDB() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Supabase는 SSL 필요
    ssl: process.env.DATABASE_URL?.includes('supabase.com')
      ? { rejectUnauthorized: false }
      : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  // 연결 테스트
  await pool.query('SELECT 1');
  await runMigrations();
  logger.info('PostgreSQL connected');
  return pool;
}

function getPool() {
  if (!pool) throw new Error('DB not initialised. Call connectDB() first.');
  return pool;
}

// ── Migrations (모두 idempotent) ──────────────────────────────────────────────
async function runMigrations() {
  await pool.query(`
    -- ── 채널 ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS channels (
      id               TEXT PRIMARY KEY,
      user_address     TEXT NOT NULL,
      operator_address TEXT NOT NULL,
      deposit_usdc     NUMERIC NOT NULL,
      status           TEXT NOT NULL DEFAULT 'open',
      latest_nonce     BIGINT NOT NULL DEFAULT 0,
      latest_state     JSONB,
      opened_tx        TEXT,
      settled_tx       TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS channel_states (
      id               SERIAL PRIMARY KEY,
      channel_id       TEXT NOT NULL REFERENCES channels(id),
      nonce            BIGINT NOT NULL,
      balance_user     NUMERIC NOT NULL,
      balance_operator NUMERIC NOT NULL,
      user_sig         TEXT,
      operator_sig     TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── 세션 ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      user_address    TEXT NOT NULL,
      service_type    TEXT NOT NULL,
      channel_id      TEXT,
      status          TEXT NOT NULL DEFAULT 'Active',
      deposit_usdc    NUMERIC,
      charged_usdc    NUMERIC DEFAULT 0,
      fare_policy_id  TEXT,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at        TIMESTAMPTZ,
      settled_at      TIMESTAMPTZ,
      meta            JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS charged_usdc NUMERIC DEFAULT 0;

    -- ── 요금 정책 ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS fare_policies (
      id           TEXT PRIMARY KEY,
      service_type TEXT NOT NULL,
      version      TEXT NOT NULL,
      policy       JSONB NOT NULL,
      is_active    BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fare_calculations (
      id             SERIAL PRIMARY KEY,
      session_id     TEXT NOT NULL,
      policy_id      TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      usage_data     JSONB NOT NULL,
      base_fare      NUMERIC NOT NULL,
      adjustments    JSONB DEFAULT '[]',
      final_fare     NUMERIC NOT NULL,
      calculated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── 서명 요청 ──────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS signature_requests (
      id           SERIAL PRIMARY KEY,
      channel_id   TEXT NOT NULL,
      session_id   TEXT,
      nonce        BIGINT NOT NULL,
      state_hash   TEXT NOT NULL,
      charge_usdc  NUMERIC,
      status       TEXT NOT NULL DEFAULT 'pending',
      user_sig     TEXT,
      operator_sig TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      signed_at    TIMESTAMPTZ,
      retry_count  INT NOT NULL DEFAULT 0
    );

    -- ── 정산 ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS settlements (
      id                 SERIAL PRIMARY KEY,
      session_id         TEXT NOT NULL,
      channel_id         TEXT NOT NULL,
      tx_hash            TEXT,
      status             TEXT NOT NULL DEFAULT 'pending',
      final_nonce        BIGINT,
      user_refund_usdc   NUMERIC,
      operator_earn_usdc NUMERIC,
      final_state        JSONB,
      confirmed_at       TIMESTAMPTZ,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── 환불 케이스 ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS refund_cases (
      id              TEXT PRIMARY KEY,
      session_id      TEXT,
      channel_id      TEXT,
      user_address    TEXT NOT NULL,
      reason          TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'RECEIVED',
      requested_usdc  NUMERIC,
      approved_usdc   NUMERIC,
      evidence        JSONB DEFAULT '[]',
      reviewer_notes  TEXT,
      auto_approved   BOOLEAN DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_at         TIMESTAMPTZ,
      closed_at       TIMESTAMPTZ
    );

    -- ── 에스크로 잠금 (V3 schema — escrowPayoutService.js 와 통일) ──────────
    CREATE TABLE IF NOT EXISTS escrow_locks (
      id                  SERIAL PRIMARY KEY,
      session_id          TEXT NOT NULL UNIQUE,
      escrow_id_bytes     TEXT NOT NULL,
      channel_id          TEXT,
      case_id             TEXT,
      user_address        TEXT NOT NULL,
      operator_address    TEXT NOT NULL,
      user_deposit        NUMERIC DEFAULT 0,
      operator_deposit    NUMERIC DEFAULT 0,
      fare_amount         NUMERIC DEFAULT 0,
      hold_deadline       TIMESTAMPTZ NOT NULL,
      user_deposit_tx     TEXT,
      operator_deposit_tx TEXT,
      settle_tx           TEXT,
      state               TEXT NOT NULL DEFAULT 'UserDeposited',
      locked_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      settled_at          TIMESTAMPTZ
    );
    -- V2→V3 마이그레이션: 구버전 컬럼 ADD IF NOT EXISTS (이미 생성된 DB 대응)
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS operator_address    TEXT;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS user_deposit        NUMERIC DEFAULT 0;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS operator_deposit    NUMERIC DEFAULT 0;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS fare_amount         NUMERIC DEFAULT 0;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS user_deposit_tx     TEXT;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS operator_deposit_tx TEXT;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS settle_tx           TEXT;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS settled_at          TIMESTAMPTZ;
    -- NOT NULL 없는 구버전 컬럼엔 기본값 채우기
    UPDATE escrow_locks SET operator_address = user_address WHERE operator_address IS NULL;
    UPDATE escrow_locks SET escrow_id_bytes  = '' WHERE escrow_id_bytes IS NULL;

    -- ── 환불 트랜잭션 (기존 호환) ──────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS refund_transactions (
      id          SERIAL PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      refund_type TEXT NOT NULL,
      amount_usdc NUMERIC NOT NULL,
      tx_hash     TEXT,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ── 인덱스 ────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_channels_user        ON channels(user_address);
    CREATE INDEX IF NOT EXISTS idx_channel_states_ch    ON channel_states(channel_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions(user_address);
    CREATE INDEX IF NOT EXISTS idx_sessions_status      ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_fare_calc_session    ON fare_calculations(session_id);
    CREATE INDEX IF NOT EXISTS idx_sigreq_channel       ON signature_requests(channel_id);
    CREATE INDEX IF NOT EXISTS idx_settlements_session  ON settlements(session_id);
    CREATE INDEX IF NOT EXISTS idx_refund_cases_session ON refund_cases(session_id);
    CREATE INDEX IF NOT EXISTS idx_refund_cases_user    ON refund_cases(user_address);
    CREATE INDEX IF NOT EXISTS idx_refund_cases_status  ON refund_cases(status);
    CREATE INDEX IF NOT EXISTS idx_escrow_session       ON escrow_locks(session_id);
    CREATE INDEX IF NOT EXISTS idx_escrow_state         ON escrow_locks(state);
  `);

  logger.info('DB migrations complete — all tables ready');
}

// ── Channel CRUD ──────────────────────────────────────────────────────────────

async function createChannelRecord({ id, userAddress, operatorAddress, depositUsdc, openedTx }) {
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

  if (extra.settledTx)                  { fields.push(`settled_tx = $${idx++}`);    values.push(extra.settledTx); }
  if (extra.latestNonce !== undefined)  { fields.push(`latest_nonce = $${idx++}`);  values.push(extra.latestNonce); }
  if (extra.latestState)                { fields.push(`latest_state = $${idx++}`);  values.push(JSON.stringify(extra.latestState)); }

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
    [channelId, state.nonce, state.balances.user, state.balances.operator,
     state.signatures?.user, state.signatures?.operator]
  );
}

async function saveRefundRecord({ channelId, refundType, amountUsdc }) {
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
