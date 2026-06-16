/**
 * Channel Routes
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /api/v1/channels/open
 * POST /api/v1/channels/:id/update
 * POST /api/v1/channels/:id/close
 * POST /api/v1/channels/:id/refund
 * GET  /api/v1/channels/:id          (state query)
 */

const { Router } = require('express');
const Joi = require('joi');
const channelManager = require('../services/channelManager');
const { isValidAddress } = require('../services/walletService');
const logger = require('../utils/logger');

const router = Router();

// ── Validation helpers ────────────────────────────────────────────────────────

const ethAddress = () =>
  Joi.string().custom((val, helpers) => {
    if (!isValidAddress(val)) return helpers.error('any.invalid');
    return val;
  }, 'Ethereum address');

const usdcAmount = () =>
  Joi.string()
    .pattern(/^\d+(\.\d{1,6})?$/)
    .required()
    .messages({ 'string.pattern.base': 'Amount must be a positive decimal with up to 6 decimal places' });

function validate(schema) {
  return (req, res, next) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        ok: false,
        errors: error.details.map((d) => d.message),
      });
    }
    req.body = value;
    next();
  };
}

// ── POST /channels/open ───────────────────────────────────────────────────────

const openSchema = Joi.object({
  userAddress: ethAddress().required(),
  depositUsdc: usdcAmount(),
});

router.post('/open', validate(openSchema), async (req, res, next) => {
  try {
    const { userAddress, depositUsdc } = req.body;
    const result = await channelManager.openChannel({ userAddress, depositUsdc });
    res.status(201).json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ── POST /channels/:id/update ─────────────────────────────────────────────────

const updateSchema = Joi.object({
  chargeUsdc: usdcAmount(),
  userSig: Joi.string().required(),
  userAddress: ethAddress().required(),
});

router.post('/:id/update', validate(updateSchema), async (req, res, next) => {
  try {
    const channelId = req.params.id;
    const { chargeUsdc, userSig, userAddress } = req.body;

    const result = await channelManager.updateChannel({
      channelId,
      chargeUsdc,
      userSig,
      userAddress,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ── POST /channels/:id/close ──────────────────────────────────────────────────

const closeSchema = Joi.object({
  userSig: Joi.string().required(),
  userAddress: ethAddress().required(),
  adjustment: Joi.object({
    creditUsdc: usdcAmount(),
  }).optional(),
});

router.post('/:id/close', validate(closeSchema), async (req, res, next) => {
  try {
    const channelId = req.params.id;
    const { userSig, userAddress, adjustment } = req.body;

    const result = await channelManager.closeChannel({
      channelId,
      userSig,
      userAddress,
      adjustment,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ── POST /channels/:id/refund ─────────────────────────────────────────────────

const refundSchema = Joi.object({
  refundUsdc: usdcAmount(),
  refundType: Joi.string().valid('adjustment', 'forced').required(),
  userAddress: ethAddress().required(),
});

router.post('/:id/refund', validate(refundSchema), async (req, res, next) => {
  try {
    const channelId = req.params.id;
    const { refundUsdc, refundType, userAddress } = req.body;

    const result = await channelManager.processRefund({
      channelId,
      refundUsdc,
      refundType,
      userAddress,
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    next(err);
  }
});

// ── GET /channels/:id ─────────────────────────────────────────────────────────

router.get('/:id', async (req, res, next) => {
  try {
    const { state, record } = await channelManager.getChannelState(req.params.id);
    if (!record) return res.status(404).json({ ok: false, error: 'Channel not found' });
    res.json({ ok: true, data: { state, record } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
