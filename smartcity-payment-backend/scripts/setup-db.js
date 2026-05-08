/**
 * DB + Redis 연결 테스트 & 초기 마이그레이션
 * 실행: node scripts/setup-db.js
 */
require('dotenv').config();

const { Pool } = require('pg');
const Redis = require('ioredis');

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

async function main() {
  console.log(`\n${BOLD}🗄️  SmartCity Payment Backend — DB Setup${RESET}\n`);

  // ── PostgreSQL ──────────────────────────────────────────────────────────────
  console.log(`${YELLOW}[1/3] PostgreSQL 연결 테스트...${RESET}`);
  if (!process.env.DATABASE_URL) {
    console.log(`${RED}  ❌ DATABASE_URL 환경변수가 없습니다.${RESET}`);
    console.log(`     .env 파일에 DATABASE_URL을 설정해주세요.`);
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('supabase.com')
      ? { rejectUnauthorized: false }
      : false,
    connectionTimeoutMillis: 8000,
  });

  try {
    const res = await pool.query('SELECT version()');
    console.log(`${GREEN}  ✅ PostgreSQL 연결 성공!${RESET}`);
    console.log(`     ${res.rows[0].version.split(',')[0]}`);
  } catch (err) {
    console.log(`${RED}  ❌ PostgreSQL 연결 실패: ${err.message}${RESET}`);
    console.log(`     DATABASE_URL을 확인해주세요.`);
    process.exit(1);
  }

  // ── 마이그레이션 ──────────────────────────────────────────────────────────
  console.log(`\n${YELLOW}[2/3] 테이블 마이그레이션...${RESET}`);
  try {
    const { connectDB } = require('../src/services/db');
    // pool 직접 주입 대신 connectDB 사용
    process.env._DB_POOL_INJECTED = 'true';

    // 직접 마이그레이션 SQL 실행
    await pool.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, user_address TEXT NOT NULL,
        operator_address TEXT NOT NULL, deposit_usdc NUMERIC NOT NULL,
        status TEXT NOT NULL DEFAULT 'open', latest_nonce BIGINT NOT NULL DEFAULT 0,
        latest_state JSONB, opened_tx TEXT, settled_tx TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS channel_states (
        id SERIAL PRIMARY KEY, channel_id TEXT NOT NULL,
        nonce BIGINT NOT NULL, balance_user NUMERIC NOT NULL,
        balance_operator NUMERIC NOT NULL, user_sig TEXT, operator_sig TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, user_address TEXT NOT NULL,
        service_type TEXT NOT NULL, channel_id TEXT,
        status TEXT NOT NULL DEFAULT 'Active', deposit_usdc NUMERIC,
        fare_policy_id TEXT, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ended_at TIMESTAMPTZ, settled_at TIMESTAMPTZ,
        meta JSONB DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS fare_policies (
        id TEXT PRIMARY KEY, service_type TEXT NOT NULL, version TEXT NOT NULL,
        policy JSONB NOT NULL, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS fare_calculations (
        id SERIAL PRIMARY KEY, session_id TEXT NOT NULL,
        policy_id TEXT NOT NULL, policy_version TEXT NOT NULL,
        usage_data JSONB NOT NULL, base_fare NUMERIC NOT NULL,
        adjustments JSONB DEFAULT '[]', final_fare NUMERIC NOT NULL,
        calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS signature_requests (
        id SERIAL PRIMARY KEY, channel_id TEXT NOT NULL, session_id TEXT,
        nonce BIGINT NOT NULL, state_hash TEXT NOT NULL, charge_usdc NUMERIC,
        status TEXT NOT NULL DEFAULT 'pending', user_sig TEXT, operator_sig TEXT,
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), signed_at TIMESTAMPTZ,
        retry_count INT NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS settlements (
        id SERIAL PRIMARY KEY, session_id TEXT NOT NULL, channel_id TEXT NOT NULL,
        tx_hash TEXT, status TEXT NOT NULL DEFAULT 'pending', final_nonce BIGINT,
        user_refund_usdc NUMERIC, operator_earn_usdc NUMERIC, final_state JSONB,
        confirmed_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS refund_cases (
        id TEXT PRIMARY KEY, session_id TEXT, channel_id TEXT,
        user_address TEXT NOT NULL, reason TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'RECEIVED', requested_usdc NUMERIC,
        approved_usdc NUMERIC, evidence JSONB DEFAULT '[]',
        reviewer_notes TEXT, auto_approved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_at TIMESTAMPTZ, closed_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS escrow_locks (
        id SERIAL PRIMARY KEY, session_id TEXT NOT NULL UNIQUE,
        channel_id TEXT, case_id TEXT, user_address TEXT NOT NULL,
        merchant_address TEXT NOT NULL, amount_usdc NUMERIC NOT NULL,
        lock_tx TEXT, release_tx TEXT, outcome TEXT DEFAULT 'pending',
        locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        release_after TIMESTAMPTZ NOT NULL, released_at TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS refund_transactions (
        id SERIAL PRIMARY KEY, channel_id TEXT NOT NULL,
        refund_type TEXT NOT NULL, amount_usdc NUMERIC NOT NULL,
        tx_hash TEXT, status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_channels_user        ON channels(user_address);
      CREATE INDEX IF NOT EXISTS idx_sessions_user        ON sessions(user_address);
      CREATE INDEX IF NOT EXISTS idx_sessions_status      ON sessions(status);
      CREATE INDEX IF NOT EXISTS idx_fare_calc_session    ON fare_calculations(session_id);
      CREATE INDEX IF NOT EXISTS idx_sigreq_channel       ON signature_requests(channel_id);
      CREATE INDEX IF NOT EXISTS idx_settlements_session  ON settlements(session_id);
      CREATE INDEX IF NOT EXISTS idx_refund_cases_session ON refund_cases(session_id);
      CREATE INDEX IF NOT EXISTS idx_refund_cases_user    ON refund_cases(user_address);
      CREATE INDEX IF NOT EXISTS idx_refund_cases_status  ON refund_cases(status);
      CREATE INDEX IF NOT EXISTS idx_escrow_session       ON escrow_locks(session_id);
      CREATE INDEX IF NOT EXISTS idx_escrow_outcome       ON escrow_locks(outcome);
    `);

    // 테이블 목록 확인
    const tables = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);

    console.log(`${GREEN}  ✅ 마이그레이션 완료! 생성된 테이블:${RESET}`);
    tables.rows.forEach(r => console.log(`     - ${r.tablename}`));

  } catch (err) {
    console.log(`${RED}  ❌ 마이그레이션 실패: ${err.message}${RESET}`);
    process.exit(1);
  }

  // ── Redis ──────────────────────────────────────────────────────────────────
  console.log(`\n${YELLOW}[3/3] Redis 연결 테스트...${RESET}`);

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log(`${YELLOW}  ⚠️  REDIS_URL 없음 — 로컬 Redis로 시도합니다.${RESET}`);
  }

  const redis = redisUrl
    ? new Redis(redisUrl, { tls: redisUrl.startsWith('rediss://') ? {} : undefined, lazyConnect: true })
    : new Redis({ host: 'localhost', port: 6379, lazyConnect: true });

  try {
    await redis.connect();
    await redis.set('_setup_test', 'ok', 'EX', 10);
    const val = await redis.get('_setup_test');
    if (val !== 'ok') throw new Error('Read-back failed');
    await redis.del('_setup_test');
    console.log(`${GREEN}  ✅ Redis 연결 성공!${RESET}`);
  } catch (err) {
    console.log(`${RED}  ❌ Redis 연결 실패: ${err.message}${RESET}`);
    console.log(`     REDIS_URL을 확인하거나 로컬 Redis를 실행해주세요.`);
  } finally {
    await redis.quit().catch(() => {});
  }

  await pool.end();

  console.log(`\n${BOLD}${GREEN}🎉 Setup 완료! 이제 npm start 로 서버를 실행하세요.${RESET}\n`);
}

main().catch(err => {
  console.error(`\n${RED}💥 Setup 실패:${RESET}`, err.message);
  process.exit(1);
});
