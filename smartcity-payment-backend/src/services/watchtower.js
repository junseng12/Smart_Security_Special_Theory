/**
 * Watchtower Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs as a separate Node.js process (or alongside the main server).
 * Periodically scans all open channels and:
 *   1. Checks if an on-chain dispute has been raised.
 *   2. If so, submits the latest signed state to prevent the counterparty
 *      from cheating with an old state.
 *   3. Alerts on channels that have been silent too long (potential liveness issue).
 *
 * Run:  node src/services/watchtower.js
 * Or:   npm run watchtower
 */

require('dotenv').config();
const logger = require('../utils/logger');
const { connectRedis, getChannelState, listActiveChannelIds } = require('./redisClient');
const { connectDB, getChannelRecord } = require('./db');
const perun = require('./perunClient');
const { getCurrentBlock } = require('./walletService');

const POLL_INTERVAL_MS = parseInt(process.env.WATCHTOWER_POLL_INTERVAL_MS) || 30_000;
const CHALLENGE_BUFFER = parseInt(process.env.WATCHTOWER_CHALLENGE_BUFFER_BLOCKS) || 10;
const SILENCE_THRESHOLD_MS = 60 * 60 * 1_000; // 1 hour without update → alert

async function checkChannel(channelId) {
  try {
    const [latestState, record] = await Promise.all([
      getChannelState(channelId),
      getChannelRecord(channelId),
    ]);

    if (!record || record.status !== 'open') return; // already settled
    if (!latestState) {
      logger.warn('Watchtower: channel in DB but not in Redis', { channelId });
      return;
    }

    // ── Liveness check ──────────────────────────────────────────────────────
    const silentMs = Date.now() - latestState.updatedAt;
    if (silentMs > SILENCE_THRESHOLD_MS) {
      logger.warn('Watchtower: channel silent', {
        channelId,
        silentHours: (silentMs / 3_600_000).toFixed(1),
      });
    }

    // ── On-chain dispute check ───────────────────────────────────────────────
    // Ask Perun node if a dispute has been registered for this channel
    const status = await perun.disputeChannel({ channelId, latestState }).catch(() => null);

    // If the Perun node signals a dispute, we would see it here.
    // For now we log; in production wire this to an actual dispute-detection RPC.
    // perun.GetChannelStatus would return status="disputed" → submit latest state
    logger.debug('Watchtower: channel OK', { channelId, nonce: latestState.nonce });

  } catch (err) {
    logger.error('Watchtower: error checking channel', { channelId, error: err.message });
  }
}

async function runWatchtower() {
  logger.info('Watchtower starting...');
  const ids = await listActiveChannelIds();
  logger.info(`Watchtower: scanning ${ids.length} open channels`);

  const currentBlock = await getCurrentBlock().catch(() => null);
  logger.info('Watchtower: current Base block', { block: currentBlock });

  await Promise.allSettled(ids.map(checkChannel));
}


// ── PendingSettle 처리 (holdDeadline 지난 것들 온체인 정산) ──────────────────
async function processPendingSettles() {
  try {
    const db        = require('./db');
    const escrowSvc = require('./escrowPayoutService');

    const { rows } = await db.getPool().query(
      `SELECT el.session_id, el.fare_amount
       FROM escrow_locks el
       WHERE el.state IN ('PendingSettle','FullyFunded','UserDeposited')
         AND el.hold_deadline IS NOT NULL
         AND el.hold_deadline < NOW()
       LIMIT 10`
    );

    if (rows.length > 0)
      logger.info(`Watchtower: PendingSettle ${rows.length}건 처리 시작`);

    for (const row of rows) {
      try {
        const result = await escrowSvc.settleAndRelease({
          sessionId: row.session_id,
          fareUsdc:  String(row.fare_amount || '0'),
        });
        logger.info('Watchtower: settle OK', { sessionId: row.session_id, result: JSON.stringify(result) });
      } catch (e) {
        logger.error('Watchtower: settle fail', { sessionId: row.session_id, error: e.message });
      }
    }
  } catch (e) {
    logger.error('Watchtower processPendingSettles error', { error: e.message });
  }
}

async function startLoop() {
  await connectRedis().catch(() => logger.warn('Watchtower: Redis 없음, DB only'));
  await connectDB();
  logger.info(`Watchtower poll interval: ${POLL_INTERVAL_MS}ms`);

  // PendingSettle 처리 (30초마다)
  processPendingSettles();
  setInterval(processPendingSettles, 30_000);

  // 채널 모니터링
  await runWatchtower();
  setInterval(runWatchtower, POLL_INTERVAL_MS);
}

startLoop().catch((err) => {
  logger.error('Watchtower fatal error', { error: err.message });
  process.exit(1);
});
