/**
 * Fare Engine v2
 * ─────────────────────────────────────────────────────────────────────────────
 * Perun 마이크로 페이먼트 원칙:
 *   - 이용 시작 즉시 1초 단위로 요금 누적
 *   - 무료 시간 없음 (freeMinutes = 0)
 *   - 매 N분 증분(incremental)으로 호출됨 → 각 호출마다 독립 계산
 *   - 요금 = durationMinutes * ratePerMinute (소수점 분 포함)
 *   - 최소 요금 = ratePerMinute (1분 요금, 즉 1초라도 과금)
 *
 * policyId 체계:
 *   "active_{serviceType}" 고정 → ON CONFLICT DO UPDATE 항상 작동
 *   version 변경해도 같은 key라서 기존 레코드 덮어씀
 */

const logger = require('../utils/logger');
const { getPool } = require('./db');

// ── 현재 활성 정책 (Perun 마이크로 페이먼트 기준) ─────────────────────────────
const ACTIVE_POLICIES = {
  bicycle: {
    version: 'v3.0',
    type: 'time_based',
    ratePerMinute: 0.01,     // USDC/분 (숫자형 — 문자열 파싱 버그 방지)
    cap: 5.00,
    freeMinutes: 0,          // 무료 없음
    penaltyLate: 1.00,
  },
  ev_charging: {
    version: 'v3.0',
    type: 'energy_based',
    ratePerKwh: 0.25,
    cap: 20.00,
    freeMinutes: 0,
    sessionFee: 0.00,
  },
  parking: {
    version: 'v3.0',
    type: 'time_based',
    ratePerMinute: 0.02,
    cap: 10.00,
    freeMinutes: 0,
    penaltyOverstay: 2.00,
  },
};

// ── DB 테이블 보장 ─────────────────────────────────────────────────────────────
async function ensureFarePolicyTable() {
  await getPool().query(`
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
    CREATE INDEX IF NOT EXISTS idx_fare_calc_session ON fare_calculations(session_id);
  `);
}

// ── 정책 조회 (항상 코드 기준, DB는 기록용) ───────────────────────────────────
async function getActivePolicy(serviceType) {
  await ensureFarePolicyTable();

  const def = ACTIVE_POLICIES[serviceType];
  if (!def) throw new Error(`No policy for serviceType: ${serviceType}`);

  // policyId: "active_{serviceType}" 고정 → version 바뀌어도 항상 같은 key
  const id = `active_${serviceType}`;

  // DB에 UPSERT — 항상 최신 코드 값으로 덮어씀
  await getPool().query(
    `INSERT INTO fare_policies (id, service_type, version, policy, is_active)
     VALUES ($1, $2, $3, $4, TRUE)
     ON CONFLICT (id) DO UPDATE
       SET policy = EXCLUDED.policy,
           version = EXCLUDED.version,
           is_active = TRUE`,
    [id, serviceType, def.version, JSON.stringify(def)]
  );

  // 구버전 레코드(v1.0, v2.0) 비활성화
  await getPool().query(
    `UPDATE fare_policies SET is_active = FALSE
     WHERE service_type = $1 AND id != $2`,
    [serviceType, id]
  ).catch(() => {});

  return { id, service_type: serviceType, version: def.version, policy: def };
}

// ── 요금 계산 (Perun 마이크로 페이먼트 — 증분 호출 기준) ──────────────────────
/**
 * @param {object} params
 * @param {string} params.sessionId
 * @param {'bicycle'|'ev_charging'|'parking'} params.serviceType
 * @param {object} params.usage
 *   - time_based:   { durationMinutes: number }  ← 이번 증분 분 (소수점 포함)
 *   - energy_based: { energyKwh: number }
 * @returns {{ fareUsdc, breakdown, policyId, policyVersion, durationMin }}
 */
async function calculateFare({ sessionId, serviceType, usage }) {
  const { policy, id, version } = await getActivePolicy(serviceType);

  let baseFare = 0;
  const adjustments = [];

  if (policy.type === 'time_based') {
    const minutes = Math.max(0, usage.durationMinutes || 0);
    // freeMinutes = 0이므로 그냥 전체 시간 과금
    baseFare = minutes * policy.ratePerMinute;

    // 패널티 (종료 시 한번만 적용)
    if (usage.isLate && policy.penaltyLate) {
      adjustments.push({ type: 'late_penalty', amount: policy.penaltyLate });
      baseFare += policy.penaltyLate;
    }
    if (usage.isOverstay && policy.penaltyOverstay) {
      const overstayHours = Math.ceil((usage.overstayMinutes || 0) / 60);
      const penalty = overstayHours * policy.penaltyOverstay;
      adjustments.push({ type: 'overstay_penalty', amount: penalty });
      baseFare += penalty;
    }

  } else if (policy.type === 'energy_based') {
    let kwh = Math.max(0, usage.energyKwh || 0);
    // energyKwh 없이 durationMinutes만 넘어올 경우 → 7kW 충전기 기준 변환 (7kW * 분/60)
    if (!kwh && usage.durationMinutes) {
      kwh = (7 * Math.max(0, usage.durationMinutes)) / 60;
    }
    baseFare = kwh * policy.ratePerKwh;
    if (policy.sessionFee > 0) {
      adjustments.push({ type: 'session_fee', amount: policy.sessionFee });
      baseFare += policy.sessionFee;
    }
  }

  // 상한
  if (baseFare > policy.cap) {
    adjustments.push({ type: 'cap_applied', originalAmount: baseFare, cappedTo: policy.cap });
    baseFare = policy.cap;
  }

  // 소수점 6자리 (USDC 6 decimals)
  const finalFare = Math.round(baseFare * 1_000_000) / 1_000_000;

  // 기록
  await getPool().query(
    `INSERT INTO fare_calculations
     (session_id, policy_id, policy_version, usage_data, base_fare, adjustments, final_fare)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [sessionId, id, version, JSON.stringify(usage), finalFare, JSON.stringify(adjustments), finalFare]
  ).catch(() => {});

  logger.info('Fare calculated (incremental)', {
    sessionId, serviceType,
    durationMinutes: usage.durationMinutes,
    finalFare,
    ratePerMinute: policy.ratePerMinute,
  });

  return {
    fareUsdc: finalFare.toFixed(6),
    breakdown: { baseFare, adjustments, ratePerMinute: policy.ratePerMinute },
    policyId: id,
    policyVersion: version,
    durationMin: (usage.durationMinutes || 0).toFixed(4),
  };
}

async function getLatestFareRecord(sessionId) {
  const result = await getPool().query(
    `SELECT * FROM fare_calculations WHERE session_id = $1 ORDER BY calculated_at DESC LIMIT 1`,
    [sessionId]
  );
  return result.rows[0] || null;
}

module.exports = { calculateFare, getActivePolicy, getLatestFareRecord };
