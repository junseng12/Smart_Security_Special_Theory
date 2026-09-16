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

async function withDatabaseSessionLock(sessionId, task) {
  const db = require('./db');
  const pool = db.getPool();
  if (typeof pool.connect !== 'function') return task();

  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`usage:${sessionId}`]);
    locked = true;
    return await task();
  } finally {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`usage:${sessionId}`]).catch(() => {});
    }
    client.release();
  }
}

function serializeSession(sessionId, task) {
  const previous = sessionTails.get(sessionId) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => withDatabaseSessionLock(sessionId, task));
  sessionTails.set(sessionId, next);
  return next.finally(() => {
    if (sessionTails.get(sessionId) === next) sessionTails.delete(sessionId);
  });
}

async function loadBillableSession(sessionId) {
  const db = require('./db');
  const { rows } = await db.getPool().query(
    `SELECT s.id, s.channel_id, s.user_address, s.service_type, s.started_at, s.ended_at,
            s.status, el.state AS escrow_state
     FROM sessions s
     LEFT JOIN escrow_locks el ON el.session_id=s.id
     WHERE s.id=$1`,
    [sessionId]
  );
  return rows[0] || null;
}

async function reconcileUsageAudit(session, channelStatus) {
  const remoteNonce = Number(channelStatus.nonce || 0);
  if (remoteNonce <= 0) return;

  const cumulativeFare = Number(channelStatus.balance_op);
  const remaining = Number(channelStatus.balance_user);
  if (!Number.isFinite(cumulativeFare) || cumulativeFare < 0 || !Number.isFinite(remaining) || remaining < 0) {
    throw new Error('Go-Perun status did not return valid cumulative balances');
  }

  const db = require('./db');
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT latest_nonce FROM channels WHERE id=$1 FOR UPDATE', [session.channel_id]);
    if (!current.rows[0]) throw new Error(`Channel audit record not found: ${session.channel_id}`);
    if (remoteNonce > Number(current.rows[0].latest_nonce || 0)) {
      const cumulative = cumulativeFare.toFixed(6);
      await client.query('UPDATE sessions SET charged_usdc=$2::NUMERIC, updated_at=NOW() WHERE id=$1', [session.id, cumulative]);
      await client.query(
        `INSERT INTO channel_states
           (channel_id, session_id, nonce, state_hash, fare_usdc, recorded_at, balance_user, balance_operator)
         SELECT $1,$2,$3,$4,$5,NOW(),$6,$7
         WHERE NOT EXISTS (SELECT 1 FROM channel_states WHERE channel_id=$1 AND nonce=$3)`,
        [session.channel_id, session.id, remoteNonce, channelStatus.state_hash || null, cumulative, remaining.toFixed(6), cumulative]
      );
      await client.query(
        `UPDATE channels SET latest_nonce=$2, latest_state=$3::jsonb, updated_at=NOW() WHERE id=$1`,
        [session.channel_id, remoteNonce, JSON.stringify({
          nonce: remoteNonce,
          stateHash: channelStatus.state_hash || null,
          fareUsdc: cumulative,
          balanceUser: remaining.toFixed(6),
          recovered: true,
        })]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function catchUpSessionUnlocked(sessionId, nowMs = Date.now(), { allowEnded = false } = {}) {
  const session = await loadBillableSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const allowedStatus = session.status === 'Active' || (allowEnded && session.status === 'Ended');
  if (!allowedStatus || session.escrow_state !== 'FullyFunded') {
    return { updated: 0, nonce: null, reason: 'not_billable' };
  }

  const cutoffMs = allowEnded && session.ended_at
    ? Math.min(nowMs, new Date(session.ended_at).getTime())
    : nowMs;
  const targetNonce = dueUsageUpdates(session.started_at, cutoffMs);
  const channelStatus = await orchestrator.getChannelStatus({ channelId: session.channel_id });
  await reconcileUsageAudit(session, channelStatus);
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

function stopAndCatchUpSession(sessionId, nowMs = Date.now()) {
  return serializeSession(sessionId, async () => {
    const session = await loadBillableSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.status === 'Active') {
      const sessionManager = require('./sessionManager');
      await sessionManager.endSession(sessionId);
    } else if (session.status !== 'Ended') {
      return { updated: 0, nonce: null, reason: 'already_stopped' };
    }
    return catchUpSessionUnlocked(sessionId, nowMs, { allowEnded: true });
  });
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

module.exports = { TICK_MS, dueUsageUpdates, catchUpSession, stopAndCatchUpSession, runBillingCycle };
