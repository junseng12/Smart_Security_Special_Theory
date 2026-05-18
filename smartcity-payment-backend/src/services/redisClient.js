const Redis = require('ioredis');
const logger = require('../utils/logger');

let client;
let redisAvailable = false;

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
        if (times > 10) return null; // 10번 이상 실패하면 포기
        const delay = Math.min(1000 * Math.pow(2, times - 1), 5000); // 1s → 2s → 4s → … → 5s
        logger.warn(`Redis retry attempt ${times}, waiting ${delay}ms...`);
        return delay;
      },
      connectTimeout: 30000,
      maxRetriesPerRequest: 3,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      commandTimeout: 30000,
    });
  } else {
    logger.warn('REDIS_URL not set — using local Redis fallback');
    client = new Redis({
      host:     process.env.REDIS_HOST     || 'localhost',
      port:     parseInt(process.env.REDIS_PORT) || 6379,
      password: process.env.REDIS_PASSWORD || undefined,
      db:       parseInt(process.env.REDIS_DB)   || 0,
      retryStrategy: (times) => {
        if (times > 10) return null;
        const delay = Math.min(1000 * Math.pow(2, times - 1), 5000);
        logger.warn(`Redis retry attempt ${times}, waiting ${delay}ms...`);
        return delay;
      },
      connectTimeout: 30000,
      enableReadyCheck: false,
      enableOfflineQueue: false,
      commandTimeout: 30000,
    });
  }

  client.on('error',       (err) => logger.error('Redis error', { error: err.message }));
  client.on('reconnecting',()    => logger.warn('Redis reconnecting...'));
  client.on('connect',     ()    => {
    redisAvailable = true;
    logger.info('Redis connected ✅');
  });
  client.on('close', () => {
    redisAvailable = false;
    logger.warn('Redis connection closed');
  });

  try {
    await Promise.race([
      client.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Redis connection timed out after 30s')), 30000)
      ),
    ]);
    redisAvailable = true;
    logger.info('Redis ready ✅');
  } catch (err) {
    logger.error('Redis unavailable — continuing in offline mode', { error: err.message });
    redisAvailable = false;
  }

  return client;
}

function getRedis() {
  if (!client) throw new Error('Redis not initialised. Call connectRedis() first.');
  return client;
}

const CHANNEL_KEY = (channelId) => `channel:${channelId}`;
const CHANNEL_TTL  = 60 * 60 * 24 * 30;

async function saveChannelState(channelId, state) {
  if (!redisAvailable) {
    logger.warn('saveChannelState skipped — Redis offline', { channelId });
    return;
  }
  try {
    await getRedis().set(CHANNEL_KEY(channelId), JSON.stringify(state), 'EX', CHANNEL_TTL);
  } catch (err) {
    logger.error('saveChannelState failed', { channelId, error: err.message });
  }
}

async function getChannelState(channelId) {
  if (!redisAvailable) {
    logger.warn('getChannelState skipped — Redis offline', { channelId });
    return null;
  }
  try {
    const raw = await getRedis().get(CHANNEL_KEY(channelId));
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.error('getChannelState failed', { channelId, error: err.message });
    return null;
  }
}

async function deleteChannelState(channelId) {
  if (!redisAvailable) {
    logger.warn('deleteChannelState skipped — Redis offline', { channelId });
    return;
  }
  try {
    await getRedis().del(CHANNEL_KEY(channelId));
  } catch (err) {
    logger.error('deleteChannelState failed', { channelId, error: err.message });
  }
}

async function listActiveChannelIds() {
  if (!redisAvailable) {
    logger.warn('listActiveChannelIds skipped — Redis offline');
    return [];
  }
  try {
    const ids = [];
    let cursor = '0';
    do {
      const [nextCursor, keys] = await getRedis().scan(cursor, 'MATCH', 'channel:*', 'COUNT', 100);
      cursor = nextCursor;
      ids.push(...keys.map((k) => k.replace('channel:', '')));
    } while (cursor !== '0');
    return ids;
  } catch (err) {
    logger.error('listActiveChannelIds failed', { error: err.message });
    return [];
  }
}

module.exports = {
  connectRedis,
  getRedis,
  saveChannelState,
  getChannelState,
  deleteChannelState,
  listActiveChannelIds,
};
