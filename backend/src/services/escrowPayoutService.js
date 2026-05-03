/**
 * Escrow Payout Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Perun 정산 완료 → Escrow 컨트랙트로 자금 Lock
 * 24h Hold & Verify → 환불 or 운영자 지급
 *
 * Dual-Path:
 *   4a. Issue 확인 → refundToBuyer(userAddress)
 *   4b. No Issue   → releaseToMerchant()
 *
 * Escrow Contract ABI:
 *   lockFunds(sessionId, buyer, merchant, amount)
 *   refundToBuyer(sessionId)
 *   releaseToMerchant(sessionId)
 *   reclaimExpired(sessionId)
 */

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { getPool } = require('./db');
const caseManager = require('./refundCaseManager');

// ── Escrow ABI (최소) ─────────────────────────────────────────────────────────
const ESCROW_ABI = [
  'function lockFunds(bytes32 sessionId, address buyer, address merchant, uint256 amount) external',
  'function refundToBuyer(bytes32 sessionId) external',
  'function releaseToMerchant(bytes32 sessionId) external',
  'function reclaimExpired(bytes32 sessionId) external',
  'function getEscrowState(bytes32 sessionId) view returns (uint8 state, uint256 amount, address buyer, address merchant, uint256 releaseTime)',
  'event FundsLocked(bytes32 indexed sessionId, address buyer, address merchant, uint256 amount)',
  'event BuyerRefunded(bytes32 indexed sessionId, uint256 amount)',
  'event MerchantPaid(bytes32 indexed sessionId, uint256 amount)',
];

const HOLD_PERIOD_HOURS = 24;

// ── 헬퍼: provider/wallet 초기화 ─────────────────────────────────────────────

function getOperatorWallet() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
  return new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);
}

function getEscrowContract(walletOrProvider) {
  const addr = process.env.ESCROW_CONTRACT_ADDRESS;
  if (!addr) throw new Error('ESCROW_CONTRACT_ADDRESS not set in env');
  return new ethers.Contract(addr, ESCROW_ABI, walletOrProvider);
}

// ── DB 마이그레이션 ────────────────────────────────────────────────────────────
async function ensureEscrowTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS escrow_locks (
      id              SERIAL PRIMARY KEY,
      session_id      TEXT NOT NULL UNIQUE,
      channel_id      TEXT,
      case_id         TEXT,
      user_address    TEXT NOT NULL,
      merchant_address TEXT NOT NULL,
      amount_usdc     NUMERIC NOT NULL,
      lock_tx         TEXT,
      release_tx      TEXT,
      outcome         TEXT,          -- 'refunded' | 'released' | 'pending'
      locked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      release_after   TIMESTAMPTZ NOT NULL,
      released_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_escrow_session ON escrow_locks(session_id);
    CREATE INDEX IF NOT EXISTS idx_escrow_outcome ON escrow_locks(outcome);
  `);
}

// ── 1. Perun 정산 완료 → Escrow Lock ─────────────────────────────────────────

/**
 * 정산 금액을 Escrow 컨트랙트에 잠금 (Hold & Verify 시작)
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.channelId
 * @param {string} params.userAddress      - buyer
 * @param {string} params.merchantAddress  - operator/merchant
 * @param {string} params.amountUsdc       - 잠글 금액 (운영자 수령분)
 */
async function lockFundsInEscrow({ sessionId, channelId, userAddress, merchantAddress, amountUsdc }) {
  await ensureEscrowTable();

  const wallet = getOperatorWallet();
  const escrow = getEscrowContract(wallet);

  const amountWei = ethers.parseUnits(amountUsdc, 6);
  const sessionIdBytes = ethers.encodeBytes32String(sessionId.slice(0, 31)); // bytes32

  logger.info('Locking funds in escrow', { sessionId, amountUsdc });

  const tx = await escrow.lockFunds(sessionIdBytes, userAddress, merchantAddress, amountWei);
  const receipt = await tx.wait();

  const releaseAfter = new Date(Date.now() + HOLD_PERIOD_HOURS * 3600 * 1000);

  await getPool().query(
    `INSERT INTO escrow_locks
     (session_id, channel_id, user_address, merchant_address, amount_usdc, lock_tx, outcome, release_after)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     ON CONFLICT (session_id) DO UPDATE SET lock_tx = $6, locked_at = NOW()`,
    [sessionId, channelId, userAddress, merchantAddress, amountUsdc, receipt.hash, releaseAfter]
  );

  logger.info('Escrow locked', { sessionId, txHash: receipt.hash, releaseAfter });
  return { txHash: receipt.hash, releaseAfter };
}

// ── 4a. Issue 확인 → 구매자 환불 ─────────────────────────────────────────────

/**
 * 환불 케이스 승인 후 Escrow에서 사용자에게 환불
 *
 * @param {string} sessionId
 * @param {string} caseId
 */
async function refundToBuyer(sessionId, caseId) {
  await ensureEscrowTable();

  const wallet = getOperatorWallet();
  const escrow = getEscrowContract(wallet);
  const sessionIdBytes = ethers.encodeBytes32String(sessionId.slice(0, 31));

  logger.info('Executing buyer refund from escrow', { sessionId, caseId });

  const tx = await escrow.refundToBuyer(sessionIdBytes);
  const receipt = await tx.wait();

  await getPool().query(
    `UPDATE escrow_locks
     SET outcome = 'refunded', release_tx = $2, released_at = NOW(), case_id = $3
     WHERE session_id = $1`,
    [sessionId, receipt.hash, caseId]
  );

  // 케이스 지급 완료
  if (caseId) {
    await caseManager.markPaid(caseId);
    await caseManager.closeCase(caseId);
  }

  logger.info('Buyer refunded from escrow', { sessionId, txHash: receipt.hash });
  return { txHash: receipt.hash };
}

// ── 4b. No Issue → 운영자 지급 ───────────────────────────────────────────────

/**
 * 이슈 없음 확인 후 Escrow에서 운영자(merchant)에게 지급
 *
 * @param {string} sessionId
 */
async function releaseToMerchant(sessionId) {
  await ensureEscrowTable();

  const wallet = getOperatorWallet();
  const escrow = getEscrowContract(wallet);
  const sessionIdBytes = ethers.encodeBytes32String(sessionId.slice(0, 31));

  logger.info('Releasing escrow to merchant', { sessionId });

  const tx = await escrow.releaseToMerchant(sessionIdBytes);
  const receipt = await tx.wait();

  await getPool().query(
    `UPDATE escrow_locks
     SET outcome = 'released', release_tx = $2, released_at = NOW()
     WHERE session_id = $1`,
    [sessionId, receipt.hash]
  );

  logger.info('Merchant paid from escrow', { sessionId, txHash: receipt.hash });
  return { txHash: receipt.hash };
}

// ── Hold 기간 만료 체크 (Watchtower 호출) ────────────────────────────────────

/**
 * 24h Hold 만료됐는데 환불 케이스 없는 세션 → releaseToMerchant
 */
async function processExpiredHolds() {
  await ensureEscrowTable();

  const result = await getPool().query(
    `SELECT el.*, rc.id as case_id, rc.status as case_status
     FROM escrow_locks el
     LEFT JOIN refund_cases rc ON rc.session_id = el.session_id
     WHERE el.outcome = 'pending'
       AND el.release_after < NOW()`
  );

  for (const lock of result.rows) {
    // 환불 케이스가 APPROVED/PAID 상태면 → 환불 처리
    if (lock.case_id && ['APPROVED'].includes(lock.case_status)) {
      await refundToBuyer(lock.session_id, lock.case_id);
    } else {
      // 이슈 없음 → 운영자 지급
      await releaseToMerchant(lock.session_id);
    }
  }

  logger.info('Expired holds processed', { count: result.rows.length });
}

/**
 * 에스크로 상태 조회
 */
async function getEscrowStatus(sessionId) {
  await ensureEscrowTable();
  const result = await getPool().query(
    'SELECT * FROM escrow_locks WHERE session_id = $1',
    [sessionId]
  );
  return result.rows[0] || null;
}

module.exports = {
  lockFundsInEscrow,
  refundToBuyer,
  releaseToMerchant,
  processExpiredHolds,
  getEscrowStatus,
};
