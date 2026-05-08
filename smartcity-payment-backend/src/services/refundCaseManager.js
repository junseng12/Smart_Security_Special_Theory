/**
 * Refund Case Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * 환불 케이스 생성 + 상태머신 관리
 *
 * 상태: RECEIVED → VERIFYING → APPROVED → PAID → CLOSED
 *                           ↘ REJECTED → CLOSED
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const { getPool } = require('./db');

const CASE_STATES = {
  RECEIVED:  'RECEIVED',
  VERIFYING: 'VERIFYING',
  APPROVED:  'APPROVED',
  REJECTED:  'REJECTED',
  PAID:      'PAID',
  CLOSED:    'CLOSED',
};

const REFUND_REASONS = [
  'sensor_failure',       // 반납 센서 미감지
  'double_charge',        // 중복 청구
  'service_outage',       // 서비스 장애
  'wrong_amount',         // 요금 오류
  'device_malfunction',   // 기기 결함
  'manual_request',       // 사용자 수동 요청
];

// ── DB 마이그레이션 ────────────────────────────────────────────────────────────
async function ensureRefundTables() {
  await getPool().query(`
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

    CREATE INDEX IF NOT EXISTS idx_refund_cases_session ON refund_cases(session_id);
    CREATE INDEX IF NOT EXISTS idx_refund_cases_user    ON refund_cases(user_address);
    CREATE INDEX IF NOT EXISTS idx_refund_cases_status  ON refund_cases(status);
  `);
}

// ── 케이스 생성 ───────────────────────────────────────────────────────────────

/**
 * 환불 케이스 생성
 * @param {object} params
 * @param {string} params.userAddress
 * @param {string} [params.sessionId]
 * @param {string} [params.channelId]
 * @param {string} params.reason       - REFUND_REASONS 중 하나
 * @param {string} [params.requestedUsdc]
 * @param {object[]} [params.evidence] - 근거 데이터 배열
 */
async function createCase({ userAddress, sessionId, channelId, reason, requestedUsdc, evidence = [] }) {
  await ensureRefundTables();

  if (!REFUND_REASONS.includes(reason)) {
    throw new Error(`Invalid reason: ${reason}. Valid: ${REFUND_REASONS.join(', ')}`);
  }

  const caseId = `case_${uuidv4().slice(0, 8)}`;

  await getPool().query(
    `INSERT INTO refund_cases
     (id, session_id, channel_id, user_address, reason, requested_usdc, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [caseId, sessionId, channelId, userAddress, reason, requestedUsdc, JSON.stringify(evidence)]
  );

  logger.info('Refund case created', { caseId, userAddress, reason, requestedUsdc });
  return { caseId, status: CASE_STATES.RECEIVED };
}

// ── 상태 전이 ─────────────────────────────────────────────────────────────────

async function _updateCaseStatus(caseId, newStatus, extra = {}) {
  const fields = ['status = $2', 'updated_at = NOW()'];
  const values = [caseId, newStatus];
  let idx = 3;

  if (extra.approvedUsdc !== undefined) { fields.push(`approved_usdc = $${idx++}`);  values.push(extra.approvedUsdc); }
  if (extra.reviewerNotes)             { fields.push(`reviewer_notes = $${idx++}`); values.push(extra.reviewerNotes); }
  if (extra.autoApproved !== undefined){ fields.push(`auto_approved = $${idx++}`);  values.push(extra.autoApproved); }
  if (extra.paidAt)                    { fields.push(`paid_at = $${idx++}`);         values.push(new Date()); }
  if (extra.closedAt)                  { fields.push(`closed_at = $${idx++}`);       values.push(new Date()); }
  if (extra.evidence) {
    fields.push(`evidence = evidence || $${idx++}::jsonb`);
    values.push(JSON.stringify([extra.evidence]));
  }

  const result = await getPool().query(
    `UPDATE refund_cases SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
    values
  );
  if (result.rows.length === 0) throw new Error(`Case ${caseId} not found`);

  logger.info('Refund case updated', { caseId, newStatus });
  return result.rows[0];
}

/** 검증 시작 */
async function startVerifying(caseId, evidence) {
  return _updateCaseStatus(caseId, CASE_STATES.VERIFYING, { evidence });
}

/** 승인 (운영자 또는 자동) */
async function approveCase(caseId, { approvedUsdc, reviewerNotes, autoApproved = false }) {
  return _updateCaseStatus(caseId, CASE_STATES.APPROVED, {
    approvedUsdc, reviewerNotes, autoApproved,
  });
}

/** 거절 */
async function rejectCase(caseId, reviewerNotes) {
  return _updateCaseStatus(caseId, CASE_STATES.REJECTED, { reviewerNotes, closedAt: true });
}

/** 지급 완료 */
async function markPaid(caseId) {
  return _updateCaseStatus(caseId, CASE_STATES.PAID, { paidAt: true });
}

/** 종결 */
async function closeCase(caseId) {
  return _updateCaseStatus(caseId, CASE_STATES.CLOSED, { closedAt: true });
}

// ── 조회 ─────────────────────────────────────────────────────────────────────

async function getCase(caseId) {
  await ensureRefundTables();
  const result = await getPool().query('SELECT * FROM refund_cases WHERE id = $1', [caseId]);
  return result.rows[0] || null;
}

async function listCases({ userAddress, status, limit = 20 } = {}) {
  await ensureRefundTables();
  const where = [];
  const values = [];
  let idx = 1;

  if (userAddress) { where.push(`user_address = $${idx++}`); values.push(userAddress); }
  if (status)      { where.push(`status = $${idx++}`);       values.push(status); }

  values.push(limit);
  const result = await getPool().query(
    `SELECT * FROM refund_cases
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY created_at DESC LIMIT $${idx}`,
    values
  );
  return result.rows;
}

module.exports = {
  CASE_STATES,
  REFUND_REASONS,
  createCase,
  startVerifying,
  approveCase,
  rejectCase,
  markPaid,
  closeCase,
  getCase,
  listCases,
};
