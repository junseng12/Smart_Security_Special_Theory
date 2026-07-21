require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const logger = require('./utils/logger');
const { connectRedis } = require('./services/redisClient');
const { connectDB } = require('./services/db');

const channelRoutes  = require('./routes/channels');
const sessionRoutes  = require('./routes/sessions');
const refundRoutes   = require('./routes/refunds');
const healthRoutes   = require('./routes/health');
const cronRoutes     = require('./routes/cron');
const errorHandler   = require('./middleware/errorHandler');
const requestValidator = require('./middleware/requestValidator');

const app = express();

app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

app.options('*', cors());
app.use(express.json());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)       || 100,
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api/', limiter);

app.use('/health',                    healthRoutes);
app.use('/internal/cron',             cronRoutes);   // 인증 불필요 — Railway 내부 ping
app.use('/api/v1/channels', requestValidator, channelRoutes);
app.use('/api/v1/sessions', requestValidator, sessionRoutes);
app.use('/api/v1/refunds',  requestValidator, refundRoutes);
app.use(errorHandler);

async function bootstrap() {
  const PORT = process.env.PORT || 3000;

  // 환경변수 로깅 (값 마스킹)
  logger.info('Env check', {
    DATABASE_URL:    process.env.DATABASE_URL ? process.env.DATABASE_URL.slice(0, 30) + '...' : 'NOT SET',
    REDIS_URL:       process.env.REDIS_URL ? process.env.REDIS_URL.slice(0, 20) + '...' : 'NOT SET',
    PERUN_GRPC_HOST: process.env.PERUN_GRPC_HOST || 'NOT SET',
    NODE_ENV:        process.env.NODE_ENV || 'NOT SET',
    PORT:            PORT,
  });

  // Redis: 실패해도 계속
  try {
    await connectRedis();
    logger.info('Redis connected ✅');
  } catch (redisErr) {
    logger.warn('Redis 연결 실패 — DB fallback 모드', {
      error: redisErr?.message || String(redisErr),
      stack: redisErr?.stack,
    });
  }

  // DB: 실패해도 서버는 시작 (에러 상세 출력)
  try {
    await connectDB();
    logger.info('DB connected ✅');
  } catch (dbErr) {
    logger.error('DB 연결 실패 — 서버는 계속 시작 (일부 기능 제한)', {
      error:   dbErr?.message || String(dbErr),
      stack:   dbErr?.stack || '(no stack)',
      errType: typeof dbErr,
      errKeys: dbErr ? Object.keys(dbErr) : [],
      errStr:  String(dbErr),
    });
    // DB 없이도 서버 시작 (go-perun 연동 기능만 동작)
  }

  // 스케줄러: 실패해도 계속
  try {
    const escrowSvc = require('./services/escrowPayoutService');
    const chainTx = require('./services/chainTransactionTracker');
    await chainTx.ensureTable();
    let schedulerRunning = false;
    async function runPendingSettles() {
      if (schedulerRunning) return;
      schedulerRunning = true;
      try {
        const db = require('./services/db');

        // 서버 재시작 전에 전송된 Base Sepolia TX부터 영수증/컨트랙트 상태 재검증
        await chainTx.reconcilePendingTransactions(20);

        // ① holdDeadline 지난 PendingSettle → settleAndRelease (돈 잠금)
        const { rows: pendingRows } = await db.getPool().query(
          `SELECT el.session_id, el.fare_amount
           FROM escrow_locks el
           JOIN sessions s ON s.id = el.session_id
           WHERE el.state IN ('PendingSettle','FullyFunded','UserDeposited')
             AND s.status IN ('Ended','Settling')
             AND el.hold_deadline IS NOT NULL
             AND el.hold_deadline < NOW()
           LIMIT 5`
        ).catch(() => ({ rows: [] }));

        for (const row of pendingRows) {
          logger.info('[Scheduler] settleAndRelease 실행', { sessionId: row.session_id });
          await escrowSvc.settleAndRelease({
            sessionId: row.session_id,
            fareUsdc:  String(row.fare_amount || '0'),
          }).catch(e => logger.error('Scheduler: settle fail', { sessionId: row.session_id, error: e.message }));
        }

      } catch (e) {
        logger.error('Scheduler error', { error: e.message });
      } finally {
        schedulerRunning = false;
      }
    }
    setInterval(runPendingSettles, 30_000);  // 30초마다 실행
    setTimeout(runPendingSettles, 5_000);    // 서버 시작 5초 후 첫 실행
  } catch (schedulerErr) {
    logger.warn('스케줄러 초기화 실패 — 계속 진행', {
      error: schedulerErr?.message || String(schedulerErr),
    });
  }

  // 서버 시작 — DB 실패해도 반드시 시작
  app.listen(PORT, () => {
    logger.info(`SmartCity Payment Backend running on port ${PORT} ✅`);
  });
}

bootstrap().catch(err => {
  logger.error('Critical bootstrap failure', {
    error:   err?.message || String(err),
    stack:   err?.stack || '(no stack)',
    errType: typeof err,
    errStr:  String(err),
  });
  process.exit(1);
});

module.exports = app;
