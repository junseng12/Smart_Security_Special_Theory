const { Router } = require('express');
const router = Router();

router.get('/', (req, res) => {
  const redis = require('../services/redisClient');
  const db = require('../services/db');
  const perunClient = require('../services/perunClient');

  Promise.all([
    redis.getRedis().ping().then(() => 'ok').catch(() => 'error'),
    db.getPool().query('SELECT 1').then(() => 'ok').catch(() => 'error'),
    perunClient.ping().catch(err => ({ connected: false, mode: perunClient.getMode(), error: err.message })),
  ]).then(([redisStatus, dbStatus, perunStatus]) => {
    const perunHost = process.env.PERUN_GRPC_HOST;
    res.json({
      status: 'healthy',
      checks: {
        redis: redisStatus,
        db: dbStatus,
        perun: perunStatus.connected ? `grpc:${perunHost}` : `${perunStatus.mode}:unavailable`,
        perun_detail: { ...perunStatus, host: perunHost || null },
      },
      ts: new Date().toISOString(),
    });
  }).catch(err => res.status(500).json({ status: 'error', error: err.message }));
});

// ── 새 추가: escrow env 상태 노출 ─────────────────────────────────────────────
router.get('/escrow-env', (req, res) => {
  const hasContract  = !!process.env.ESCROW_CONTRACT_ADDRESS;
  const hasPrivKey   = !!process.env.OPERATOR_PRIVATE_KEY;
  const hasOpAddr    = !!process.env.OPERATOR_ADDRESS;
  const hasUsdcAddr  = !!process.env.USDC_CONTRACT_ADDRESS;
  const ready        = hasContract && hasPrivKey;

  res.json({
    ok: true,
    escrow_ready: ready,
    env: {
      ESCROW_CONTRACT_ADDRESS: hasContract ? process.env.ESCROW_CONTRACT_ADDRESS : '❌ NOT SET',
      OPERATOR_PRIVATE_KEY:    hasPrivKey  ? '✅ SET (hidden)' : '❌ NOT SET',
      OPERATOR_ADDRESS:        hasOpAddr   ? process.env.OPERATOR_ADDRESS : '❌ NOT SET',
      USDC_CONTRACT_ADDRESS:   hasUsdcAddr ? process.env.USDC_CONTRACT_ADDRESS : '❌ NOT SET',
      ESCROW_VERSION:          process.env.ESCROW_VERSION || '❌ NOT SET',
      ESCROW_HOLD_SECONDS:     process.env.ESCROW_HOLD_SECONDS || '300 (default)',
      OPERATOR_DEPOSIT_USDC:   process.env.OPERATOR_DEPOSIT_USDC || '3.0 (default)',
    },
    message: ready
      ? '✅ settleAndRelease 온체인 정산 가능'
      : '❌ ESCROW_CONTRACT_ADDRESS 또는 OPERATOR_PRIVATE_KEY 미설정 → 온체인 정산 불가',
  });
});

module.exports = router;
