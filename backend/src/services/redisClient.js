const Redis = require('ioredis');
const logger = require('../utils/logger');

let client;

/**
 * Connect to Redis. Called once at bootstrap.
 */
async function connectRedis() {
  client = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB) || 0,
    retryStrategy: (times) => Math.min(times * 100, 3000),
    lazyConnect: true,
  });

  client.on('error', (err) => logger.error('Redis error', { error: err.message }));
  client.on('reconnecting', () => logger.warn('Redis reconnecting...'));

  await client.connect();
  logger.info('Redis connected');
  return client;
}

function getRedis() {
  if (!client) throw new Error('Redis not initialised. Call connectRedis() first.');
  return client;
}

// ── Channel state helpers ────────────────────────────────────────────────────

const CHANNEL_KEY = (channelId) => `channel:${channelId}`;
const CHANNEL_TTL = 60 * 60 * 24 * 30; // 30 days

/**
 * Save the latest channel state.
 * @param {string} channelId
 * @param {object} state  - { nonce, balances: { user, operator }, signatures, updatedAt }
 */
async function saveChannelState(channelId, state) {
  const redis = getRedis();
  await redis.set(CHANNEL_KEY(channelId), JSON.stringify(state), 'EX', CHANNEL_TTL);
}

/**
 * Retrieve the latest channel state.
 */
async function getChannelState(channelId) {
  const redis = getRedis();
  const raw = await redis.get(CHANNEL_KEY(channelId));
  return raw ? JSON.parse(raw) : null;
}

/**
 * Delete channel state after final settlement.
 */
async function deleteChannelState(channelId) {
  const redis = getRedis();
  await redis.del(CHANNEL_KEY(channelId));
}

/**
 * List all active channel IDs (uses SCAN to avoid blocking).
 */
async function listActiveChannelIds() {
  const redis = getRedis();
  const ids = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'channel:*', 'COUNT', 100);
    cursor = nextCursor;
    ids.push(...keys.map((k) => k.replace('channel:', '')));
  } while (cursor !== '0');
  return ids;
}

module.exports = {
  connectRedis,
  getRedis,
  saveChannelState,
  getChannelState,
  deleteChannelState,
  listActiveChannelIds,
};
