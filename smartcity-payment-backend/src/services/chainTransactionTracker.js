/**
 * Base Sepolia transaction tracker for the currently deployed escrow contract.
 *
 * Financial completion is confirmed only when both conditions are true:
 *   1. The transaction receipt succeeded on Base Sepolia.
 *   2. getEscrowStatus(escrowId) matches the expected final state.
 */

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { getPool } = require('./db');

const CHAIN_ID = 84532;
const ESCROW_ADDR = process.env.ESCROW_CONTRACT_ADDRESS
  || '0xa2642876a2Aa9F19D22a6e69379bbcA10556977f';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://sepolia.base.org';
const REVIEW_AFTER_MS = Number(process.env.CHAIN_TX_REVIEW_AFTER_MS || 10 * 60 * 1000);

const ESCROW_ABI = [
  'function getEscrowStatus(bytes32 escrowId) external view returns (uint8 state, uint256 userDeposit, uint256 operatorDeposit, uint256 fareAmount, address user, address operator, uint256 holdDeadline, bool isFullyFunded, bool isDeadlinePassed)',
];
const STATE_LABELS = ['None', 'UserDeposited', 'FullyFunded', 'RefundIssue', 'Released', 'Refunded'];
const EXPECTED_STATE = { SETTLE: 4, REFUND: 5 };

function getProvider() {
  return new ethers.JsonRpcProvider(BASE_RPC);
}

function toEscrowId(sessionId) {
  return ethers.keccak256(ethers.toUtf8Bytes(sessionId));
}

async function ensureTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS chain_transactions (
      id                 BIGSERIAL PRIMARY KEY,
      session_id         TEXT NOT NULL,
      action             TEXT NOT NULL,
      chain_id           BIGINT NOT NULL DEFAULT 84532,
      contract_address   TEXT NOT NULL,
      escrow_id          TEXT NOT NULL,
      tx_hash            TEXT,
      status             TEXT NOT NULL DEFAULT 'QUEUED',
      block_number       BIGINT,
      receipt            JSONB,
      submitted_at       TIMESTAMPTZ,
      confirmed_at       TIMESTAMPTZ,
      last_checked_at    TIMESTAMPTZ,
      last_error         TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_chain_tx_session ON chain_transactions(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chain_tx_status  ON chain_transactions(status, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_tx_hash
      ON chain_transactions(tx_hash) WHERE tx_hash IS NOT NULL;
  `);
}

async function queueTransaction({ sessionId, action }) {
  if (!EXPECTED_STATE[action]) throw new Error(`Unsupported chain action: ${action}`);
  await ensureTable();
  const escrowId = toEscrowId(sessionId);
  const { rows } = await getPool().query(
    `INSERT INTO chain_transactions
       (session_id, action, chain_id, contract_address, escrow_id, status)
     VALUES ($1, $2, $3, $4, $5, 'QUEUED')
     RETURNING *`,
    [sessionId, action, CHAIN_ID, ESCROW_ADDR.toLowerCase(), escrowId]
  );
  return rows[0];
}

async function markSubmitted(id, txHash) {
  await getPool().query(
    `UPDATE chain_transactions
     SET tx_hash=$2, status='SUBMITTED', submitted_at=NOW(),
         last_checked_at=NOW(), last_error=NULL, updated_at=NOW()
     WHERE id=$1`,
    [id, txHash]
  );
}

async function markProblem(id, status, error) {
  const allowed = new Set(['REVERTED', 'NEEDS_REVIEW']);
  const next = allowed.has(status) ? status : 'NEEDS_REVIEW';
  await getPool().query(
    `UPDATE chain_transactions
     SET status=$2, last_error=$3, last_checked_at=NOW(), updated_at=NOW()
     WHERE id=$1 AND status <> 'CONFIRMED'`,
    [id, next, String(error || 'unknown chain error').slice(0, 500)]
  );
}

async function getOnchainState(sessionId, provider = getProvider()) {
  const escrow = new ethers.Contract(ESCROW_ADDR, ESCROW_ABI, provider);
  const result = await escrow.getEscrowStatus(toEscrowId(sessionId));
  const state = Number(result[0]);
  return { state, stateLabel: STATE_LABELS[state] || 'Unknown' };
}

async function invalidateSessionCache(sessionId, channelId) {
  try {
    const redis = require('./redisClient').getRedis();
    if (!redis) return;
    const keys = [`session:${sessionId}`];
    if (channelId) keys.push(`channel:${channelId}`);
    await redis.del(...keys);
  } catch (err) {
    logger.warn('Chain tracker cache invalidation failed', { sessionId, error: err.message });
  }
}

async function syncFinalState(sessionId, stateLabel, txHash = null) {
  if (!['Released', 'Refunded'].includes(stateLabel)) {
    throw new Error(`Cannot sync non-final escrow state: ${stateLabel}`);
  }

  const client = await getPool().connect();
  let channelId = null;
  try {
    await client.query('BEGIN');
    const sessionResult = await client.query(
      'SELECT channel_id FROM sessions WHERE id=$1 FOR UPDATE',
      [sessionId]
    );
    channelId = sessionResult.rows[0]?.channel_id || null;

    await client.query(
      `UPDATE escrow_locks
       SET state=$2,
           settle_tx=COALESCE($3, settle_tx),
           settled_at=COALESCE(settled_at, NOW()),
           last_error=NULL
       WHERE session_id=$1`,
      [sessionId, stateLabel, txHash]
    );
    await client.query(
      `UPDATE sessions
       SET status='Settled', settled_at=COALESCE(settled_at, NOW()), updated_at=NOW()
       WHERE id=$1`,
      [sessionId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await invalidateSessionCache(sessionId, channelId);
  return { sessionId, state: stateLabel };
}

function receiptSnapshot(receipt) {
  return {
    transactionHash: receipt.hash,
    blockHash: receipt.blockHash,
    blockNumber: Number(receipt.blockNumber),
    status: Number(receipt.status),
    to: receipt.to,
  };
}

async function confirmTransaction(id, suppliedReceipt = null) {
  await ensureTable();
  const { rows } = await getPool().query(
    'SELECT * FROM chain_transactions WHERE id=$1',
    [id]
  );
  const record = rows[0];
  if (!record) throw new Error(`Chain transaction ${id} not found`);
  if (!record.tx_hash) return { confirmed: false, reason: 'tx_not_submitted' };

  const provider = getProvider();
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== CHAIN_ID) {
    await markProblem(id, 'NEEDS_REVIEW', `wrong_chain:${network.chainId}`);
    return { confirmed: false, reason: 'wrong_chain' };
  }

  const receipt = suppliedReceipt || await provider.getTransactionReceipt(record.tx_hash);
  if (!receipt) {
    const submittedAt = record.submitted_at ? new Date(record.submitted_at).getTime() : Date.now();
    const overdue = Date.now() - submittedAt > REVIEW_AFTER_MS;
    await getPool().query(
      `UPDATE chain_transactions
       SET status=$2, last_checked_at=NOW(), updated_at=NOW(),
           last_error=CASE WHEN $2='NEEDS_REVIEW' THEN 'receipt_not_found' ELSE last_error END
       WHERE id=$1`,
      [id, overdue ? 'NEEDS_REVIEW' : 'SUBMITTED']
    );
    return { confirmed: false, reason: overdue ? 'receipt_overdue' : 'receipt_pending' };
  }

  if (Number(receipt.status) !== 1) {
    await markProblem(id, 'REVERTED', 'receipt_status_0');
    return { confirmed: false, reason: 'transaction_reverted' };
  }

  if (!receipt.to || receipt.to.toLowerCase() !== ESCROW_ADDR.toLowerCase()) {
    await markProblem(id, 'NEEDS_REVIEW', `wrong_contract:${receipt.to || 'null'}`);
    return { confirmed: false, reason: 'wrong_contract' };
  }

  const onchain = await getOnchainState(record.session_id, provider);
  const expectedState = EXPECTED_STATE[record.action];
  if (onchain.state !== expectedState) {
    await markProblem(
      id,
      'NEEDS_REVIEW',
      `state_mismatch:expected=${STATE_LABELS[expectedState]},actual=${onchain.stateLabel}`
    );
    return { confirmed: false, reason: 'state_mismatch', onchain };
  }

  const client = await getPool().connect();
  let channelId = null;
  try {
    await client.query('BEGIN');
    const sessionResult = await client.query(
      'SELECT channel_id FROM sessions WHERE id=$1 FOR UPDATE',
      [record.session_id]
    );
    channelId = sessionResult.rows[0]?.channel_id || null;
    await client.query(
      `UPDATE chain_transactions
       SET status='CONFIRMED', block_number=$2, receipt=$3,
           confirmed_at=NOW(), last_checked_at=NOW(), last_error=NULL, updated_at=NOW()
       WHERE id=$1`,
      [id, Number(receipt.blockNumber), JSON.stringify(receiptSnapshot(receipt))]
    );
    await client.query(
      `UPDATE escrow_locks
       SET state=$2, settle_tx=$3, settled_at=NOW(), last_error=NULL
       WHERE session_id=$1`,
      [record.session_id, onchain.stateLabel, receipt.hash]
    );
    await client.query(
      `UPDATE sessions
       SET status='Settled', settled_at=NOW(), updated_at=NOW()
       WHERE id=$1`,
      [record.session_id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  await invalidateSessionCache(record.session_id, channelId);
  logger.info('Base Sepolia transaction confirmed', {
    sessionId: record.session_id,
    action: record.action,
    txHash: receipt.hash,
    state: onchain.stateLabel,
  });
  return { confirmed: true, txHash: receipt.hash, onchain };
}

async function reconcilePendingTransactions(limit = 20) {
  await ensureTable();
  const { rows } = await getPool().query(
    `SELECT id, tx_hash, status, created_at
     FROM chain_transactions
     WHERE status IN ('QUEUED', 'SUBMITTED', 'NEEDS_REVIEW')
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );

  const results = [];
  for (const row of rows) {
    if (!row.tx_hash) {
      if (Date.now() - new Date(row.created_at).getTime() > REVIEW_AFTER_MS) {
        await markProblem(row.id, 'NEEDS_REVIEW', 'transaction_not_submitted');
      }
      results.push({ id: row.id, confirmed: false, reason: 'tx_not_submitted' });
      continue;
    }
    try {
      results.push({ id: row.id, ...(await confirmTransaction(row.id)) });
    } catch (err) {
      await markProblem(row.id, 'NEEDS_REVIEW', err.message).catch(() => {});
      results.push({ id: row.id, confirmed: false, reason: err.message });
    }
  }
  return results;
}

module.exports = {
  CHAIN_ID,
  ESCROW_ADDR,
  ensureTable,
  queueTransaction,
  markSubmitted,
  markProblem,
  confirmTransaction,
  reconcilePendingTransactions,
  getOnchainState,
  syncFinalState,
};
