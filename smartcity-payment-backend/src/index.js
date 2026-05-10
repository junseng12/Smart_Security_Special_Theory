require('dotenv').config();
const express = require('express');
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
app.use(helmet({ crossOriginResourcePolicy: false }));

// CORS: 모든 origin 허용 (데모용)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

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
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  }
}

bootstrap();
module.exports = app;
