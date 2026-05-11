const logger = require('../utils/logger');

// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  logger.error('Unhandled error', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
  });

  // Known operational errors
  const knownErrors = [
    'Channel not found',
    'Channel is not open',
    'Invalid user signature',
    'Insufficient channel balance',
    'Operator balance insufficient',
  ];

  const isOperational = knownErrors.some((msg) => err.message.startsWith(msg));

  if (isOperational) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  // Generic 500
  res.status(500).json({
    ok: false,
    error: err.message, // DEBUG: 임시 에러 노출
  });
};
