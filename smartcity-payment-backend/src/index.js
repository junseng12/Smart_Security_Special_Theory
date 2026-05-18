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
const errorHandler   = require('./middleware/errorHandler');
const requestValidator = require('./middleware/requestValidator');

const app = express();

// ── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [];

app.use(cors({
  origin: (origin, callback) => {
    // origin 없는 요청 (서버간, curl 등) 허용
    if (!origin) return callback(null, true);
    // 허용 목록이 비어있으면 전체 허용
    if (allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

// OPTIONS preflight 전체 허용
app.options('*', cors());

app.use(express.json());
app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60_000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)       || 100,
  standardHeaders: true,
  legacyHeaders:   false,
});
app.use('/api/', limiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/health',                    healthRoutes);
app.use('/api/v1/channels', requestValidator, channelRoutes);
app.use('/api/v1/sessions', requestValidator, sessionRoutes);
app.use('/api/v1/refunds',  requestValidator, refundRoutes);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use(errorHandler);

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
  try {
    await connectRedis();
    await connectDB();
    logger.info('Redis and DB connected');

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      logger.info(`SmartCity Payment Backend running on port ${PORT}`);
      logger.info('Routes:');
      logger.info('  POST /api/v1/sessions/start');
      logger.info('  POST /api/v1/sessions/:id/charge');
      logger.info('  POST /api/v1/sessions/:id/sign');
      logger.info('  POST /api/v1/sessions/:id/end');
      logger.info('  GET  /api/v1/sessions/:id/status');
      logger.info('  GET  /api/v1/sessions/:id/stream  (SSE)');
      logger.info('  POST /api/v1/refunds');
      logger.info('  POST /api/v1/refunds/:id/evaluate');
      logger.info('  POST /api/v1/refunds/:id/approve');
      logger.info('  POST /api/v1/refunds/:id/payout');
      logger.info('  GET  /health');
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  }
}

bootstrap();
module.exports = app;
