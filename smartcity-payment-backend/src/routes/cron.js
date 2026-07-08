/**
 * GET /internal/cron/settle-pending
 * PendingSettle 상태 세션을 holdDeadline 지난 것부터 순서대로 settleAndRelease 실행
 * Railway Cron 또는 외부 ping으로 호출 (매 1분)
 */
const express = require('express');
const router = express.Router();
const { getPool } = require('../services/db');
const escrowSvc = require('../services/escrowPayoutService');
const logger = require('../utils/logger');

router.get('/settle-pending', async (req, res) => {
  try {
    const now = Math.floor(Date.now() / 1000);

    // holdDeadline 지난 PendingSettle 세션 조회 (최대 5개씩 처리)
    const { rows } = await getPool().query(`
      SELECT el.session_id, el.fare_amount, el.hold_deadline, el.user_deposit
      FROM escrow_locks el
      WHERE el.state = 'PendingSettle'
        AND (
          el.hold_deadline IS NULL
          OR EXTRACT(EPOCH FROM el.hold_deadline) <= $1
        )
      ORDER BY el.hold_deadline ASC
      LIMIT 5
    `, [now]);

    if (rows.length === 0) {
      return res.json({ ok: true, processed: 0, message: 'No pending sessions' });
    }

    logger.info(`[Cron] PendingSettle 처리 대상: ${rows.length}개`, {});
    const results = [];

    for (const row of rows) {
      try {
        const result = await escrowSvc.settleAndRelease({
          sessionId: row.session_id,
          fareUsdc:  row.fare_amount || '0',
        });
        results.push({ sessionId: row.session_id, result });
        logger.info(`[Cron] settle done`, { sessionId: row.session_id, result });
      } catch (err) {
        results.push({ sessionId: row.session_id, error: err.message });
        logger.error(`[Cron] settle failed`, { sessionId: row.session_id, error: err.message });
      }
    }

    res.json({ ok: true, processed: rows.length, results });
  } catch (err) {
    logger.error('[Cron] settle-pending error', { error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
