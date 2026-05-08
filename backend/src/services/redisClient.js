const Redis = require('ioredis');
const logger = require('../utils/logger');

let client;

async function connectRedis() {
  const redisUrl = process.env.REDIS_URL;

  if (redisUrl) {
    // Upstash 등 클라우드 Redis — URL 파싱 후 명시적 옵션으로 연결
    const parsed = new URL(redisUrl);
    client = new Redis({
      host:     parsed.hostname,
      port:     parseInt(parsed.port),
      username: parsed.username || 'default',
      password: parsed.password,
      tls: redisUrl.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      lazyConnect: true,
    });
  } else {
    // 로컬 Redis
    client = new Redis({
      host:     process.env.REDIS_HOST     || 'localhost',
      port:     parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db:       parseInt(process.env.REDIS_DB)   || 0,
      retryStrategy: (times) => Math.min(times * 200, 5000),
      lazyConnect: true,
    });
  }

  client.on('error',       (err) => logger.error('Redis error', { error: err.message }));
  client.on('reconnecting',()    => logger.warn('Redis reconnecting...'));
  client.on('connect',     ()    => logger.info('Redis connected'));

  await client.connect();
  return client;
}

function getRedis() {
  if (!client) throw new Error('Redis not initialised. Call connectRedis() first.');
  return client;
}

const CHANNEL_KEY = (channelId) => `channel:${channelId}`;
const CHANNEL_TTL  = 60 * 60 * 24 * 30;

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
