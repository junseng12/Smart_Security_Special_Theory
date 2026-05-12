/**
 * Fare Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * 사용량 → 요금 계산 + 정책 버전 관리
 *
 * 정책은 DB에 버전별로 저장되어, 분쟁 시 "어떤 정책으로 과금했는지" 증명 가능.
 */

const logger = require('../utils/logger');
const { getPool } = require('./db');

// ── 기본 요금 정책 (v1) ───────────────────────────────────────────────────────
const DEFAULT_POLICIES = {
  bicycle: {
    version: 'v2.0',          // freeMinutes 제거 — 1분부터 과금
    type: 'time_based',
    ratePerMinute: '0.01',    // USDC per minute
    minimumFare: '0.01',      // 최소 1분 요금 (freeMinutes 없으므로 1분=0.01)
    cap: '5.00',
    freeMinutes: 0,           // 무료 시간 없음
    penaltyLate: '1.00',
  },
  ev_charging: {
    version: 'v2.0',
    type: 'energy_based',
    ratePerKwh: '0.25',
    minimumFare: '0.25',      // 최소 1kWh 기준
    cap: '20.00',
    sessionFee: '0.00',       // 기본료 없음
  },
  parking: {
    version: 'v2.0',
    type: 'time_based',
    ratePerMinute: '0.02',
    minimumFare: '0.02',      // 최소 1분 요금
    cap: '10.00',
    freeMinutes: 0,           // 무료 시간 없음
    penaltyOverstay: '2.00',
  },
};

// ── DB 마이그레이션 ────────────────────────────────────────────────────────────
async function ensureFarePolicyTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS fare_policies (
      id          TEXT PRIMARY KEY,
      service_type TEXT NOT NULL,
      version     TEXT NOT NULL,
      policy      JSONB NOT NULL,
      is_active   BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS fare_calculations (
      id            SERIAL PRIMARY KEY,
      session_id    TEXT NOT NULL,
      policy_id     TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      usage_data    JSONB NOT NULL,
      base_fare     NUMERIC NOT NULL,
      adjustments   JSONB DEFAULT '[]',
      final_fare    NUMERIC NOT NULL,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_fare_calc_session ON fare_calculations(session_id);
  `);
}

// ── 정책 관리 ─────────────────────────────────────────────────────────────────

/**
 * 현재 활성 정책 조회 (없으면 DEFAULT_POLICIES 사용)
 */
async function getActivePolicy(serviceType) {
  await ensureFarePolicyTable();

  const result = await getPool().query(
    `SELECT * FROM fare_policies
     WHERE service_type = $1 AND is_active = TRUE
     ORDER BY created_at DESC LIMIT 1`,
    [serviceType]
  );

  if (result.rows.length > 0) {
    return result.rows[0];
  }

  // 없으면 기본 정책 DB에 저장 후 반환
  const def = DEFAULT_POLICIES[serviceType];
  if (!def) throw new Error(`No policy for service type: ${serviceType}`);

  const id = `policy_${serviceType}_${def.version}`;
  await getPool().query(
    `INSERT INTO fare_policies (id, service_type, version, policy)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET policy=EXCLUDED.policy, version=EXCLUDED.version`,
    [id, serviceType, def.version, JSON.stringify(def)]
  );

  return { id, service_type: serviceType, version: def.version, policy: def };
}

// ── 요금 계산 ─────────────────────────────────────────────────────────────────

/**
 * 사용량 → 요금 계산
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {'bicycle'|'ev_charging'|'parking'} params.serviceType
 * @param {object} params.usage
 *   - bicycle/parking: { durationMinutes: number, isLate?: boolean }
 *   - ev_charging:     { energyKwh: number }
 *
 * @returns {{ fareUsdc: string, breakdown: object, policyId: string, policyVersion: string }}
 */
async function calculateFare({ sessionId, serviceType, usage }) {
  const policyRecord = await getActivePolicy(serviceType);
  const policy = policyRecord.policy || policyRecord; // DB row vs default

  let baseFare = 0;
  const adjustments = [];

  // ── 서비스별 계산 ──────────────────────────────────────────────────────────
  if (policy.type === 'time_based') {
    const billableMinutes = Math.max(0, (usage.durationMinutes || 0) - (policy.freeMinutes || 0));
    baseFare = billableMinutes * parseFloat(policy.ratePerMinute);

    if (usage.isLate && policy.penaltyLate) {
      const penalty = parseFloat(policy.penaltyLate);
      adjustments.push({ type: 'late_penalty', amount: penalty });
      baseFare += penalty;
    }

    if (usage.isOverstay && policy.penaltyOverstay) {
      const overstayHours = Math.ceil((usage.overstayMinutes || 0) / 60);
      const penalty = overstayHours * parseFloat(policy.penaltyOverstay);
      adjustments.push({ type: 'overstay_penalty', amount: penalty });
      baseFare += penalty;
    }
  } else if (policy.type === 'energy_based') {
    baseFare = (usage.energyKwh || 0) * parseFloat(policy.ratePerKwh);
    if (policy.sessionFee) {
      const fee = parseFloat(policy.sessionFee);
      adjustments.push({ type: 'session_fee', amount: fee });
      baseFare += fee;
    }
  }

  // ── 정책 적용 ──────────────────────────────────────────────────────────────
  // 최소 요금
  const minimum = parseFloat(policy.minimumFare || 0);
  if (baseFare < minimum && baseFare > 0) {
    adjustments.push({ type: 'minimum_fare_applied', amount: minimum - baseFare });
    baseFare = minimum;
  }

  // 상한 (cap)
  const cap = parseFloat(policy.cap || Infinity);
  if (baseFare > cap) {
    adjustments.push({ type: 'cap_applied', originalAmount: baseFare, cappedTo: cap });
    baseFare = cap;
  }

  const finalFare = Math.round(baseFare * 1_000_000) / 1_000_000; // 6 decimal

  // ── 기록 ──────────────────────────────────────────────────────────────────
  await getPool().query(
    `INSERT INTO fare_calculations
     (session_id, policy_id, policy_version, usage_data, base_fare, adjustments, final_fare)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      sessionId,
      policyRecord.id,
      policyRecord.version || policy.version,
      JSON.stringify(usage),
      finalFare,
      JSON.stringify(adjustments),
      finalFare,
    ]
  );

  logger.info('Fare calculated', { sessionId, serviceType, finalFare, adjustments });

  return {
    fareUsdc: finalFare.toFixed(6),
    breakdown: { baseFare, adjustments },
    policyId: policyRecord.id,
    policyVersion: policyRecord.version || policy.version,
  };
}

/**
 * 세션의 최신 요금 계산 기록 조회
 */
async function getLatestFareRecord(sessionId) {
  const result = await getPool().query(
    `SELECT * FROM fare_calculations
     WHERE session_id = $1
     ORDER BY calculated_at DESC LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

module.exports = {
  calculateFare,
  getActivePolicy,
  getLatestFareRecord,
};
