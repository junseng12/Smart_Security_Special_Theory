const Redis = require('ioredis');
const logger = require('../utils/logger');

let client;

/**
 * Connect to Redis.
 * REDIS_URL 환경변수가 있으면 URL 방식 (Upstash 등 클라우드)
 * 없으면 HOST/PORT 방식 (로컬)
 */
async function connectRedis() {
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    // Upstash 등 TLS Redis — URL 방식
    client = new Redis(redisUrl, {
      tls: redisUrl.startsWith('rediss://') ? {} : undefined,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      lazyConnect: true,
    });
  } else {
    // 로컬 Redis — HOST/PORT 방식
    client = new Redis({
      host:     process.env.REDIS_HOST     || 'localhost',
      port:     parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db:       parseInt(process.env.REDIS_DB)   || 0,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      lazyConnect: true,
    });
  }

  client.on('error', (err) => logger.error('Redis error', { error: err.message }));
  client.on('reconnecting', () => logger.warn('Redis reconnecting...'));
  client.on('connect', () => logger.info('Redis connected'));

  await client.connect();
  return client;
}

function getRedis() {
  if (!client) throw new Error('Redis not initialised. Call connectRedis() first.');
  return client;
}

// ── Channel state helpers ─────────────────────────────────────────────────────

const CHANNEL_KEY = (channelId) => `channel:${channelId}`;
const CHANNEL_TTL  = 60 * 60 * 24 * 30; // 30일

async function saveChannelState(channelId, state) {
  await getRedis().set(CHANNEL_KEY(channelId), JSON.stringify(state), 'EX', CHANNEL_TTL);
}

async function getChannelState(channelId) {
  const raw = await getRedis().get(CHANNEL_KEY(channelId));
  return raw ? JSON.parse(raw) : null;
}

async function deleteChannelState(channelId) {
  await getRedis().del(CHANNEL_KEY(channelId));
}

async function listActiveChannelIds() {
  const ids = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await getRedis().scan(cursor, 'MATCH', 'channel:*', 'COUNT', 100);
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
