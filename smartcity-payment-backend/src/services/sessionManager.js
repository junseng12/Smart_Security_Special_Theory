/**
 * Session Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * 서비스 이용 단위(자전거/충전/주차)의 세션 라이프사이클 관리
 *
 * 상태머신: Active → Ended → Settling → Settled (또는 Disputed)
 *
 * Redis: 활성 세션 hot state
 * DB:    전체 세션 이력
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { getRedis } = require('./redisClient');
const { getPool } = require('./db');

// ── 상수 ──────────────────────────────────────────────────────────────────────
const SESSION_STATES = {
  ACTIVE: 'Active',
  ENDED: 'Ended',
  SETTLING: 'Settling',
  SETTLED: 'Settled',
  DISPUTED: 'Disputed',
  FORCE_CLOSED: 'ForceClosed',
};

const SERVICE_TYPES = ['bicycle', 'ev_charging', 'parking'];
const MAX_SESSION_DURATION_MS = 5 * 60 * 60 * 1000; // 5시간
const SESSION_KEY = (id) => `session:${id}`;
const SESSION_TTL = 60 * 60 * 24 * 7; // 7일

// ── DB 마이그레이션 ────────────────────────────────────────────────────────────
async function ensureSessionTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      user_address    TEXT NOT NULL,
      service_type    TEXT NOT NULL,
      channel_id      TEXT,
      status          TEXT NOT NULL DEFAULT 'Active',
      deposit_usdc    NUMERIC,
      fare_policy_id  TEXT,
      started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at        TIMESTAMPTZ,
      settled_at      TIMESTAMPTZ,
      meta            JSONB DEFAULT '{}',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_address);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  `);
}

// ── 세션 생성 ─────────────────────────────────────────────────────────────────

/**
 * 새 세션 시작
 * @param {object} params
 * @param {string} params.userAddress
 * @param {'bicycle'|'ev_charging'|'parking'} params.serviceType
 * @param {string} params.depositUsdc
 * @param {object} [params.meta]  - 추가 메타 (자전거 ID, 충전기 ID 등)
 */
async function startSession({ userAddress, serviceType, depositUsdc, meta = {} }) {
  if (!SERVICE_TYPES.includes(serviceType)) {
    throw new Error(`Invalid serviceType: ${serviceType}. Must be one of ${SERVICE_TYPES.join(', ')}`);
  }

  await ensureSessionTable();

  const sessionId = uuidv4();
  const now = Date.now();

  const sessionData = {
    id: sessionId,
    userAddress,
    serviceType,
    depositUsdc,
    status: SESSION_STATES.ACTIVE,
    channelId: null,
    startedAt: now,
    endedAt: null,
    settledAt: null,
    meta,
    timeoutAt: now + MAX_SESSION_DURATION_MS,
  };

  // Redis 저장
  const redis = getRedis();
  await redis.set(SESSION_KEY(sessionId), JSON.stringify(sessionData), 'EX', SESSION_TTL);

  // DB 저장
  await getPool().query(
    `INSERT INTO sessions (id, user_address, service_type, deposit_usdc, meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, userAddress, serviceType, depositUsdc, JSON.stringify(meta)]
  );

  logger.info('Session started', { sessionId, userAddress, serviceType });
  return sessionData;
}

// ── 세션 조회 ─────────────────────────────────────────────────────────────────

async function getSession(sessionId) {
  const redis = getRedis();
  const raw = await redis.get(SESSION_KEY(sessionId));
  if (raw) return JSON.parse(raw);

  // Redis miss → DB fallback
  const result = await getPool().query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
  return result.rows[0] || null;
}

// ── 상태 전이 ─────────────────────────────────────────────────────────────────

async function _updateSessionState(sessionId, newStatus, extra = {}) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const updated = { ...session, status: newStatus, ...extra, updatedAt: Date.now() };

  // Redis 업데이트
  const redis = getRedis();
  await redis.set(SESSION_KEY(sessionId), JSON.stringify(updated), 'EX', SESSION_TTL);

  // DB 업데이트
  const fields = ['status = $2', 'updated_at = NOW()'];
  const values = [sessionId, newStatus];
  let idx = 3;

  if (extra.channelId) { fields.push(`channel_id = $${idx++}`); values.push(extra.channelId); }
  if (extra.endedAt)   { fields.push(`ended_at = $${idx++}`);   values.push(new Date(extra.endedAt)); }
  if (extra.settledAt) { fields.push(`settled_at = $${idx++}`); values.push(new Date(extra.settledAt)); }

  await getPool().query(
    `UPDATE sessions SET ${fields.join(', ')} WHERE id = $1`,
    values
  );

  logger.info('Session state changed', { sessionId, newStatus });
  return updated;
}

/** 채널 연결 (오픈 직후 호출) */
async function linkChannel(sessionId, channelId) {
  return _updateSessionState(sessionId, SESSION_STATES.ACTIVE, { channelId });
}

/** 세션 종료 (사용자 반납 / 타임아웃) */
async function endSession(sessionId, { forced = false } = {}) {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (session.status !== SESSION_STATES.ACTIVE) {
    throw new Error(`Session ${sessionId} is already ${session.status}`);
  }

  const newStatus = forced ? SESSION_STATES.FORCE_CLOSED : SESSION_STATES.ENDED;
  return _updateSessionState(sessionId, newStatus, { endedAt: Date.now() });
}

/** 정산 시작 */
async function markSettling(sessionId) {
  return _updateSessionState(sessionId, SESSION_STATES.SETTLING);
}

/** 정산 완료 */
async function markSettled(sessionId) {
  return _updateSessionState(sessionId, SESSION_STATES.SETTLED, { settledAt: Date.now() });
}

/** 분쟁 상태 */
async function markDisputed(sessionId) {
  return _updateSessionState(sessionId, SESSION_STATES.DISPUTED);
}

// ── 타임아웃 감지 ─────────────────────────────────────────────────────────────

/**
 * 5시간 초과 활성 세션 목록 반환 (Watchtower에서 주기적으로 호출)
 */
async function getExpiredSessions() {
  const result = await getPool().query(
    `SELECT * FROM sessions
     WHERE status = 'Active'
       AND started_at < NOW() - INTERVAL '5 hours'`
  );
  return result.rows;
}

module.exports = {
  SESSION_STATES,
  startSession,
  getSession,
  linkChannel,
  endSession,
  markSettling,
  markSettled,
  markDisputed,
  getExpiredSessions,
};
