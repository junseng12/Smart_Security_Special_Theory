'use strict';

const orchestrator = require('./channelOrchestrator');
const logger = require('../utils/logger');

const TICK_MS = 60_000;
const MAX_CATCH_UP_PER_RUN = 5;
const sessionTails = new Map();

function dueUsageUpdates(startedAt, nowMs = Date.now()) {
  const startMs = new Date(startedAt).getTime();
  if (!Number.isFinite(startMs)) return 0;
  return Math.max(0, Math.floor((nowMs - startMs) / TICK_MS));
}

function serializeSession(sessionId, task) {
  const previous = sessionTails.get(sessionId) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  sessionTails.set(sessionId, next);
  return next.finally(() => {
    if (sessionTails.get(sessionId) === next) sessionTails.delete(sessionId);
  });
}

async function loadBillableSession(sessionId) {
  const db = require('./db');
  const { rows } = await db.getPool().query(
    `SELECT s.id, s.channel_id, s.user_address, s.service_type, s.started_at,
            s.status, el.state AS escrow_state
     FROM sessions s
     LEFT JOIN escrow_locks el ON el.session_id=s.id
     WHERE s.id=$1`,
    [sessionId]
  );
  return rows[0] || null;
}

async function catchUpSessionUnlocked(sessionId, nowMs = Date.now()) {
  const session = await loadBillableSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status !== 'Active' || session.escrow_state !== 'FullyFunded') {
    return { updated: 0, nonce: null, reason: 'not_billable' };
  }

  const targetNonce = dueUsageUpdates(session.started_at, nowMs);
  const channelStatus = await orchestrator.getChannelStatus({ channelId: session.channel_id });
  let nonce = Number(channelStatus.nonce || 0);
  let updated = 0;
  let latest = null;

  while (nonce < targetNonce && updated < MAX_CATCH_UP_PER_RUN) {
    latest = await orchestrator.chargeUsage({
      sessionId: session.id,
      channelId: session.channel_id,
      userAddress: session.user_address,
      serviceType: session.service_type,
      usage: { durationMinutes: 1 },
    });
    nonce = Number(latest.updatedState.nonce);
    updated += 1;
  }

  return { updated, nonce, targetNonce, latest };
}

function catchUpSession(sessionId, nowMs = Date.now()) {
  return serializeSession(sessionId, () => catchUpSessionUnlocked(sessionId, nowMs));
}

async function runBillingCycle(nowMs = Date.now()) {
  const db = require('./db');
  const { rows } = await db.getPool().query(
    `SELECT s.id
     FROM sessions s
     JOIN escrow_locks el ON el.session_id=s.id
     WHERE s.status='Active'
       AND el.state='FullyFunded'
       AND s.started_at <= NOW() - INTERVAL '1 minute'
       AND el.hold_deadline > NOW()
     ORDER BY s.started_at
     LIMIT 20`
  );

  for (const row of rows) {
    await catchUpSession(row.id, nowMs).catch(err => {
      logger.error('[UsageBilling] session update failed', {
        sessionId: row.id,
        error: err.message,
      });
    });
  }
  return rows.length;
}

module.exports = { TICK_MS, dueUsageUpdates, catchUpSession, runBillingCycle };
