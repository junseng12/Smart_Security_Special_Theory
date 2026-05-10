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
    version: 'v1.0',
    type: 'time_based',
    ratePerMinute: '0.01',    // USDC per minute
    minimumFare: '0.10',      // 최소 10센트
    cap: '5.00',              // 최대 5 USDC (5시간 기준)
    freeMinutes: 2,           // 첫 2분 무료
    penaltyLate: '1.00',      // 미반납 패널티 (per 30min)
  },
  ev_charging: {
    version: 'v1.0',
    type: 'energy_based',
    ratePerKwh: '0.25',       // USDC per kWh
    minimumFare: '0.50',
    cap: '20.00',
    sessionFee: '0.10',       // 연결 기본료
  },
  parking: {
    version: 'v1.0',
    type: 'time_based',
    ratePerMinute: '0.02',
    minimumFare: '0.20',
    cap: '10.00',
    freeMinutes: 10,          // 첫 10분 무료
    penaltyOverstay: '2.00',  // 초과 시 per hour
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
     ON CONFLICT (id) DO NOTHING`,
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
  // DB에서 읽은 JSONB 필드는 문자열일 수 있으므로 강제 변환
  const ratePerMinute  = parseFloat(policy.ratePerMinute  || 0);
  const ratePerKwh     = parseFloat(policy.ratePerKwh     || 0);
  const freeMinutes    = parseFloat(policy.freeMinutes    || 0);
  const penaltyLate    = parseFloat(policy.penaltyLate    || 0);
  const penaltyOverstay= parseFloat(policy.penaltyOverstay|| 0);
  const minimumFare    = parseFloat(policy.minimumFare    || 0);
  const capFare        = parseFloat(policy.cap            || 999);
  const sessionFee     = parseFloat(policy.sessionFee     || 0);

  if (policy.type === 'time_based') {
    const billableMinutes = Math.max(0, (usage.durationMinutes || 0) - freeMinutes);
    baseFare = billableMinutes * ratePerMinute;

    if (usage.isLate && penaltyLate) {
      adjustments.push({ type: 'late_penalty', amount: penaltyLate });
      baseFare += penaltyLate;
    }

    if (usage.isOverstay && penaltyOverstay) {
      const overstayHours = Math.ceil((usage.overstayMinutes || 0) / 60);
      const penalty = overstayHours * penaltyOverstay;
      adjustments.push({ type: 'overstay_penalty', amount: penalty });
      baseFare += penalty;
    }
  } else if (policy.type === 'energy_based') {
    baseFare = (usage.energyKwh || 0) * ratePerKwh;
    if (sessionFee) {
      adjustments.push({ type: 'session_fee', amount: sessionFee });
      baseFare += sessionFee;
    }
  }

  // ── 정책 적용 ──────────────────────────────────────────────────────────────
  // 최소 요금 (baseFare > 0 조건 제거 — 0분이어도 최소 요금 적용)
  if (baseFare > 0 && baseFare < minimumFare) {
    adjustments.push({ type: 'minimum_fare_applied', amount: minimumFare - baseFare });
    baseFare = minimumFare;
  }

  // 상한 (cap)
  if (baseFare > capFare) {
    adjustments.push({ type: 'cap_applied', originalAmount: baseFare, cappedTo: capFare });
    baseFare = capFare;
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
