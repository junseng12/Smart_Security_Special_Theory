/**
 * Fare Engine v2 — always uses hardcoded numeric policies (no DB cache issue)
 */
const logger = require('../utils/logger');
const { getPool } = require('./db');

const DEFAULT_POLICIES = {
  bicycle: {
    id: 'policy_bicycle_v1.0', version: 'v1.0', type: 'time_based',
    ratePerMinute: 0.01, minimumFare: 0.10, cap: 5.00, freeMinutes: 2, penaltyLate: 1.00,
  },
  ev_charging: {
    id: 'policy_ev_charging_v1.0', version: 'v1.0', type: 'energy_based',
    ratePerKwh: 0.25, minimumFare: 0.50, cap: 20.00, sessionFee: 0.10,
  },
  parking: {
    id: 'policy_parking_v1.0', version: 'v1.0', type: 'time_based',
    ratePerMinute: 0.02, minimumFare: 0.20, cap: 10.00, freeMinutes: 10, penaltyOverstay: 2.00,
  },
};

async function ensureFarePolicyTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS fare_policies (
      id TEXT PRIMARY KEY, service_type TEXT NOT NULL,
      version TEXT NOT NULL, policy JSONB NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS fare_calculations (
      id SERIAL PRIMARY KEY, session_id TEXT NOT NULL,
      policy_id TEXT NOT NULL, policy_version TEXT NOT NULL,
      usage_data JSONB NOT NULL, base_fare NUMERIC NOT NULL,
      adjustments JSONB DEFAULT '[]', final_fare NUMERIC NOT NULL,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fare_calc_session ON fare_calculations(session_id);
  `);
}

function getPolicy(serviceType) {
  const p = DEFAULT_POLICIES[serviceType];
  if (!p) throw new Error('No policy for service type: ' + serviceType);
  return p;
}

async function calculateFare({ sessionId, serviceType, usage }) {
  await ensureFarePolicyTable();
  const policy = getPolicy(serviceType);
  let baseFare = 0;
  const adjustments = [];

  if (policy.type === 'time_based') {
    const rawMinutes = Number(usage.durationMinutes) || 0;
    const billable = Math.max(0, rawMinutes - policy.freeMinutes);
    baseFare = billable * policy.ratePerMinute;
    logger.info('Fare calc', { serviceType, rawMinutes, freeMinutes: policy.freeMinutes, billable, rate: policy.ratePerMinute, baseFare });

    if (usage.isLate && policy.penaltyLate) {
      adjustments.push({ type: 'late_penalty', amount: policy.penaltyLate });
      baseFare += policy.penaltyLate;
    }
    if (usage.isOverstay && policy.penaltyOverstay) {
      const h = Math.ceil((usage.overstayMinutes || 0) / 60);
      const pen = h * policy.penaltyOverstay;
      adjustments.push({ type: 'overstay_penalty', amount: pen });
      baseFare += pen;
    }
  } else if (policy.type === 'energy_based') {
    baseFare = (Number(usage.energyKwh) || 0) * policy.ratePerKwh;
    if (policy.sessionFee) {
      adjustments.push({ type: 'session_fee', amount: policy.sessionFee });
      baseFare += policy.sessionFee;
    }
  }

  if (baseFare > 0 && baseFare < policy.minimumFare) {
    adjustments.push({ type: 'minimum_fare_applied', amount: policy.minimumFare - baseFare });
    baseFare = policy.minimumFare;
  }
  if (baseFare > policy.cap) {
    adjustments.push({ type: 'cap_applied', originalAmount: baseFare, cappedTo: policy.cap });
    baseFare = policy.cap;
  }

  const finalFare = Math.round(baseFare * 1_000_000) / 1_000_000;

  try {
    await getPool().query(
      'INSERT INTO fare_calculations (session_id,policy_id,policy_version,usage_data,base_fare,adjustments,final_fare) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [sessionId, policy.id, policy.version, JSON.stringify(usage), finalFare, JSON.stringify(adjustments), finalFare]
    );
  } catch(e) { logger.warn('Fare record insert failed', { err: e.message }); }

  logger.info('Fare calculated', { sessionId, serviceType, finalFare, adjustments });
  return {
    fareUsdc: finalFare.toFixed(6),
    breakdown: { baseFare, adjustments },
    policyId: policy.id,
    policyVersion: policy.version,
  };
}

async function getActivePolicy(serviceType) { return getPolicy(serviceType); }

async function getLatestFareRecord(sessionId) {
  try {
    const r = await getPool().query(
      'SELECT * FROM fare_calculations WHERE session_id=$1 ORDER BY calculated_at DESC LIMIT 1',
      [sessionId]
    );
    return r.rows[0] || null;
  } catch { return null; }
}

module.exports = { calculateFare, getActivePolicy, getLatestFareRecord };
