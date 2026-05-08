const Redis = require('ioredis');
const logger = require('../utils/logger');

let client;

async function connectRedis() {
  const redisUrl = process.env.REDIS_URL;

  // 연결 전 환경변수 확인 로그 (디버깅용)
  logger.info('Redis init', {
    hasUrl: !!redisUrl,
    urlPrefix: redisUrl ? redisUrl.substring(0, 20) + '...' : 'MISSING',
  });

  if (redisUrl) {
    // ioredis는 rediss:// URL을 직접 받으면 자동으로 TLS 처리함
    // URL 파싱 없이 그대로 전달 + tls 옵션만 명시
    client = new Redis(redisUrl, {
      tls: {
        rejectUnauthorized: false,
      },
      retryStrategy: (times) => {
        if (times > 5) return null; // 5번 이상 실패하면 포기
        return Math.min(times * 500, 3000);
      },
      lazyConnect: true,
      connectTimeout: 10000,
      maxRetriesPerRequest: 3,
    });
  } else {
    logger.warn('REDIS_URL not set — using local Redis fallback');
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
  client.on('connect',     ()    => logger.info('Redis connected ✅'));

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
