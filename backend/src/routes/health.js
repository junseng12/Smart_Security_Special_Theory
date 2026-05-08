const { Router } = require('express');
const { getRedis } = require('../services/redisClient');
const { getPool } = require('../services/db');
const perunClient = require('../services/perunClient');

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

  // Perun node ping
  try {
    const perunStatus = await perunClient.pingPerun();
    checks.perun = perunStatus.mode === 'grpc' && perunStatus.connected
      ? 'ok'
      : `mock:${perunStatus.mode}`;
    checks.perun_detail = perunStatus;
  } catch {
    checks.perun = 'error';
  }

  const critical = ['redis', 'db'];
  const healthy = critical.every((k) => checks[k] === 'ok');

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    checks,
    ts: new Date().toISOString(),
  });
});

// Perun 재연결 엔드포인트 (운영 중 Perun 노드 띄웠을 때 사용)
router.post('/perun/reinit', (req, res) => {
  const result = perunClient.reinitGrpc();
  res.json({ ok: true, ...result });
});

module.exports = router;
