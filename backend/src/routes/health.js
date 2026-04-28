const { Router } = require('express');
const { getRedis } = require('../services/redisClient');
const { getPool } = require('../services/db');

const router = Router();

router.get('/', async (req, res) => {
  const checks = {};

  // Redis ping
  try {
    await getRedis().ping();
    checks.redis = 'ok';
  } catch {
    checks.redis = 'error';
  }

  // DB ping
  try {
    await getPool().query('SELECT 1');
    checks.db = 'ok';
  } catch {
    checks.db = 'error';
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    checks,
    ts: new Date().toISOString(),
  });
});

module.exports = router;
