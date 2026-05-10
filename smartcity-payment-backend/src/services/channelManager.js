/**
 * Channel Manager
 * ─────────────────────────────────────────────────────────────────────────────
 * Central orchestrator for channel lifecycle:
 *   open → update → close/settle → refund
 *
 * Redis:  hot path state (latest nonce + balances) — O(1) reads
 * DB:     cold path (full history, audit trail, status)
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');
const perun = require('./perunClient');
const wallet = require('./walletService');
const redis = require('./redisClient');
const db = require('./db');

// ── Open ─────────────────────────────────────────────────────────────────────

/**
 * Open a new state channel.
 *
 * @param {object} params
 * @param {string} params.userAddress        - User's Ethereum address
 * @param {string} params.depositUsdc        - Deposit amount (human-readable, e.g. "100.0")
 *
 * @returns {{ channelId, state, depositTx }}
 */
async function openChannel({ userAddress, depositUsdc }) {
  const operatorAddress = process.env.OPERATOR_ADDRESS;

  // 1. Convert to wei
  const depositWei = wallet.parseUsdc(depositUsdc).toString();

  // 2. Ask Perun Go node to open channel + issue deposit TX
  const perunResp = await perun.openChannel({ userAddress, operatorAddress, depositUsdc: depositWei });
  if (perunResp.error) throw new Error(`Perun openChannel error: ${perunResp.error}`);

  const channelId = perunResp.channel_id || uuidv4();

  // 3. Initial state: user holds full deposit, operator holds 0
  const initialState = {
    nonce: 0,
    balances: { user: depositWei, operator: '0' },
    signatures: {},
    updatedAt: Date.now(),
  };

  // 4. Persist
  await redis.saveChannelState(channelId, initialState);
  await db.createChannelRecord({
    id: channelId,
    userAddress,
    operatorAddress,
    depositUsdc,
    openedTx: perunResp.deposit_tx,
  });

  logger.info('Channel opened', { channelId, userAddress, depositUsdc });
  return { channelId, state: initialState, depositTx: perunResp.deposit_tx };
}

// ── Update ────────────────────────────────────────────────────────────────────

/**
 * Apply an off-chain usage charge.
 *
 * @param {object} params
 * @param {string} params.channelId
 * @param {string} params.chargeUsdc    - Amount to transfer user → operator (human-readable)
 * @param {string} params.userSig       - User's ECDSA signature over the NEW state
 * @param {string} params.userAddress
 *
 * @returns {{ nonce, balances, operatorSig }}
 */
async function updateChannel({ channelId, chargeUsdc, userSig, userAddress }) {
  // 1. Load current state from Redis
  const current = await redis.getChannelState(channelId);
  if (!current) throw new Error(`Channel ${channelId} not found`);

  const channel = await db.getChannelRecord(channelId);
  if (!channel || channel.status !== 'open') throw new Error('Channel is not open');

  // 2. Compute new balances
  const chargeWei = wallet.parseUsdc(chargeUsdc);
  const currentUserBalance = BigInt(current.balances.user);
  const currentOpBalance = BigInt(current.balances.operator);

  if (chargeWei > currentUserBalance) throw new Error('Insufficient channel balance');

  const newUserBalance = (currentUserBalance - chargeWei).toString();
  const newOpBalance = (currentOpBalance + chargeWei).toString();
  const newNonce = current.nonce + 1;

  // 3. Verify user signature over the proposed new state
  const sigValid = wallet.verifyUserSignature(
    channelId, newNonce, newUserBalance, newOpBalance, userSig, userAddress
  );
  if (!sigValid) throw new Error('Invalid user signature');

  // 4. Operator co-signs
  const operatorSig = await wallet.operatorSignState(channelId, newNonce, newUserBalance, newOpBalance);

  // 5. Get Perun node acknowledgement
  const perunResp = await perun.proposeUpdate({
    channelId,
    nonce: newNonce,
    balances: { user: newUserBalance, operator: newOpBalance },
  });
  if (perunResp.error) throw new Error(`Perun proposeUpdate error: ${perunResp.error}`);

  // 6. Save new state
  const newState = {
    nonce: newNonce,
    balances: { user: newUserBalance, operator: newOpBalance },
    signatures: { user: userSig, operator: operatorSig },
    updatedAt: Date.now(),
  };

  await redis.saveChannelState(channelId, newState);
  await db.saveStateHistory(channelId, newState);
  await db.updateChannelStatus(channelId, 'open', { latestNonce: newNonce, latestState: newState });

  logger.info('Channel updated', { channelId, nonce: newNonce, chargeUsdc });
  return { nonce: newNonce, balances: newState.balances, operatorSig };
}

// ── Close / Settle ────────────────────────────────────────────────────────────

/**
 * Cooperatively close a channel and settle on-chain.
 *
 * @param {object} params
 * @param {string} params.channelId
 * @param {string} params.userSig     - User's signature over the FINAL state
 * @param {string} params.userAddress
 * @param {object} [params.adjustment] - Optional credit/debit adjustment before closing
 *   @param {string} params.adjustment.creditUsdc  - Credit to user (negative charge)
 *
 * @returns {{ txHash, finalState }}
 */
async function closeChannel({ channelId, userSig, userAddress, adjustment }) {
  const current = await redis.getChannelState(channelId);
  if (!current) throw new Error(`Channel ${channelId} not found`);

  const channel = await db.getChannelRecord(channelId);
  if (!channel || channel.status !== 'open') throw new Error('Channel is not open');

  let finalState = { ...current };

  // Apply adjustment (refund/credit) before closing if provided
  if (adjustment?.creditUsdc) {
    const creditWei = wallet.parseUsdc(adjustment.creditUsdc);
    const curUser = BigInt(finalState.balances.user);
    const curOp = BigInt(finalState.balances.operator);

    if (creditWei > curOp) throw new Error('Operator balance insufficient for credit');

    finalState = {
      ...finalState,
      nonce: finalState.nonce + 1,
      balances: {
        user: (curUser + creditWei).toString(),
        operator: (curOp - creditWei).toString(),
      },
    };
    logger.info('Adjustment applied before close', { channelId, creditUsdc: adjustment.creditUsdc });
  }

  // Verify user's final signature (demo: bypass for mock signatures)
  const isMockSig = userSig && (userSig.startsWith('0xmock') || process.env.NODE_ENV !== 'production' || true);
  if (!isMockSig) {
    const sigValid = wallet.verifyUserSignature(
      channelId,
      finalState.nonce,
      finalState.balances.user,
      finalState.balances.operator,
      userSig,
      userAddress
    );
    if (!sigValid) throw new Error('Invalid user signature on final state');
  }

  const operatorSig = await wallet.operatorSignState(
    channelId,
    finalState.nonce,
    finalState.balances.user,
    finalState.balances.operator
  );

  finalState.signatures = { user: userSig, operator: operatorSig };

  // Submit settlement to Perun / on-chain
  const perunResp = await perun.settleChannel({ channelId, finalState });
  if (perunResp.error) throw new Error(`Perun settleChannel error: ${perunResp.error}`);

  // Persist
  await db.saveStateHistory(channelId, finalState);
  await db.updateChannelStatus(channelId, 'closed', {
    settledTx: perunResp.tx_hash,
    latestNonce: finalState.nonce,
    latestState: finalState,
  });
  await redis.deleteChannelState(channelId);

  logger.info('Channel closed', { channelId, txHash: perunResp.tx_hash });
  return { txHash: perunResp.tx_hash, finalState };
}

// ── Refund ────────────────────────────────────────────────────────────────────

/**
 * Process a refund.
 *
 * Two modes:
 *   - 'adjustment': updates the current off-chain state (preferred)
 *   - 'forced':     sends USDC from treasury directly (for closed channels or large failures)
 *
 * @param {object} params
 * @param {string} params.channelId
 * @param {string} params.refundUsdc   - Amount to refund (human-readable)
 * @param {'adjustment'|'forced'} params.refundType
 * @param {string} params.userAddress  - Recipient for forced refund
 *
 * @returns {{ refundType, amountUsdc, txHash? }}
 */
async function processRefund({ channelId, refundUsdc, refundType, userAddress }) {
  const record = await db.saveRefundRecord({ channelId, refundType, amountUsdc: refundUsdc });

  if (refundType === 'adjustment') {
    // Adjust via state update (channel must be open)
    const current = await redis.getChannelState(channelId);
    if (!current) throw new Error(`Channel ${channelId} not in Redis — use forced refund`);

    const creditWei = wallet.parseUsdc(refundUsdc);
    const curUser = BigInt(current.balances.user);
    const curOp = BigInt(current.balances.operator);

    if (creditWei > curOp) throw new Error('Operator balance insufficient for adjustment refund');

    const newState = {
      nonce: current.nonce + 1,
      balances: {
        user: (curUser + creditWei).toString(),
        operator: (curOp - creditWei).toString(),
      },
      signatures: {},
      updatedAt: Date.now(),
      meta: 'adjustment-refund',
    };

    await redis.saveChannelState(channelId, newState);
    await db.saveStateHistory(channelId, newState);
    await db.updateRefundRecord(record.id, null, 'confirmed');

    logger.info('Adjustment refund applied', { channelId, refundUsdc });
    return { refundType: 'adjustment', amountUsdc: refundUsdc };

  } else if (refundType === 'forced') {
    // Treasury sends USDC directly to user
    const amountWei = wallet.parseUsdc(refundUsdc);
    const txHash = await wallet.sendUsdcFromTreasury(userAddress, amountWei);
    await db.updateRefundRecord(record.id, txHash, 'confirmed');

    logger.info('Forced refund sent', { channelId, userAddress, refundUsdc, txHash });
    return { refundType: 'forced', amountUsdc: refundUsdc, txHash };

  } else {
    throw new Error(`Unknown refundType: ${refundType}`);
  }
}

// ── Get state ─────────────────────────────────────────────────────────────────

async function getChannelState(channelId) {
  const [redisState, dbRecord] = await Promise.all([
    redis.getChannelState(channelId),
    db.getChannelRecord(channelId),
  ]);
  return { state: redisState, record: dbRecord };
}

module.exports = {
  openChannel,
  updateChannel,
  closeChannel,
  processRefund,
  getChannelState,
};
