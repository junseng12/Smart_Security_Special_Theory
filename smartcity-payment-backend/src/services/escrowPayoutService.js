/**
 * escrowPayoutService.js — SmartCityEscrow (실제 배포 버전)
 *
 * 실제 배포 컨트랙트(0x454Dd98f) 함수:
 *   createEscrow(escrowId, buyer, seller, amount, holdDeadline) → Operator가 USDC 예치
 *   registerRefundIssue(escrowId, issueType, description)
 *   releaseToSeller(escrowId)  → holdDeadline 경과 후 Seller에게 즉시 전송
 *   refundToBuyer(escrowId)    → RefundIssue 상태에서 Buyer에게 즉시 전송
 *   getEscrowStatus(escrowId)  → (state, amount, buyer, seller, holdDeadline, isDeadlinePassed)
 */

const { ethers } = require('ethers');
const logger     = require('../utils/logger');

const ESCROW_ADDR = process.env.ESCROW_CONTRACT_ADDRESS || '0xa2642876a2Aa9F19D22a6e69379bbcA10556977f';
const USDC_ADDR   = process.env.USDC_CONTRACT_ADDRESS   || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_RPC    = process.env.BASE_RPC_URL             || 'https://sepolia.base.org';

const ESCROW_ABI = [
  'function createEscrow(bytes32 escrowId, address buyer, address seller, uint256 amount, uint256 holdDeadline) external',
  'function registerRefundIssue(bytes32 escrowId, uint8 issueType, string calldata description) external',
  'function releaseToSeller(bytes32 escrowId) external',
  'function refundToBuyer(bytes32 escrowId) external',
  'function emergencyCancel(bytes32 escrowId) external',
  'function getEscrowStatus(bytes32 escrowId) external view returns (uint8 state, uint256 amount, address buyer, address seller, uint256 holdDeadline, bool isDeadlinePassed)',
  'function isDeadlinePassed(bytes32 escrowId) external view returns (bool)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

// EscrowState: None(0) Held(1) RefundIssue(2) Released(3) Refunded(4)
const STATE_LABELS = ['None', 'Held', 'RefundIssue', 'Released', 'Refunded'];

const ISSUE_TYPE_MAP = {
  unlock_failure: 0, device_fault: 1, wrong_charge: 2,
  sensor_failure: 3, service_outage: 4, other: 5,
  double_charge: 2, wrong_amount: 2, device_malfunction: 1, manual_request: 5,
};

// [TEST] 4분 — 운영 시 86400으로 복원
const HOLD_DEADLINE_SEC = 4 * 60;

function getProvider()  { return new ethers.JsonRpcProvider(BASE_RPC); }
function getWallet()    { return new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, getProvider()); }
function getEscrow(sw)  { return new ethers.Contract(ESCROW_ADDR, ESCROW_ABI, sw); }
function getUsdc(sw)    { return new ethers.Contract(USDC_ADDR,   ERC20_ABI,  sw); }
function toEscrowId(id) { return ethers.keccak256(ethers.toUtf8Bytes(id)); }
function getPool()      { return require('./db').getPool(); }

async function ensureTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS escrow_locks (
      id SERIAL PRIMARY KEY, session_id TEXT UNIQUE NOT NULL,
      escrow_id_bytes TEXT, channel_id TEXT, case_id TEXT,
      user_address TEXT, seller_address TEXT, amount_usdc NUMERIC(18,6),
      hold_deadline TIMESTAMPTZ, create_tx TEXT, release_tx TEXT,
      state TEXT DEFAULT 'None', locked_at TIMESTAMPTZ DEFAULT NOW(),
      released_at TIMESTAMPTZ, operator_address TEXT,
      user_deposit NUMERIC(18,6) DEFAULT 0, operator_deposit NUMERIC(18,6) DEFAULT 0,
      fare_amount NUMERIC(18,6) DEFAULT 0,
      user_deposit_tx TEXT, operator_deposit_tx TEXT,
      settle_tx TEXT, settled_at TIMESTAMPTZ, claimable_after TIMESTAMPTZ,
      retry_count INTEGER DEFAULT 0, last_error TEXT
    )
  `).catch(() => {});
}

// ── 1. recordUserDeposit ─────────────────────────────────────────────────────
// 유저가 MetaMask로 예치 완료 → 백엔드가 createEscrow 실행 (Operator가 USDC 예치)
async function recordUserDeposit({ sessionId, channelId, userAddress, operatorAddress, depositUsdc, holdDeadline, depositTxHash }) {
  await ensureTable();
  const escrowId = toEscrowId(sessionId);
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const usdc     = getUsdc(wallet);
  const deadline = holdDeadline || (Math.floor(Date.now() / 1000) + HOLD_DEADLINE_SEC);
  const seller   = operatorAddress || wallet.address;

  let onchainState = 0;
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    onchainState = Number(s[0]);
  } catch(e) {}

  let createTx = depositTxHash;
  if (onchainState === 0) {
    logger.info('recordUserDeposit: createEscrow 실행', { sessionId });
    try {
      const amtWei = ethers.parseUnits(String(depositUsdc || '3'), 6);
      const al = await usdc.allowance(wallet.address, ESCROW_ADDR);
      if (al < amtWei) {
        const atx = await usdc.approve(ESCROW_ADDR, amtWei * 10n, { gasLimit: 80000 });
        await atx.wait();
      }
      const tx = await escrow.createEscrow(escrowId, userAddress, seller, amtWei, deadline, { gasLimit: 250000 });
      const r  = await tx.wait();
      createTx = r.hash;
      logger.info('createEscrow OK', { sessionId, tx: r.hash });
    } catch(e) {
      logger.error('createEscrow 실패', { sessionId, error: e.message });
    }
  }

  await getPool().query(
    `INSERT INTO escrow_locks
       (session_id, escrow_id_bytes, channel_id, user_address, operator_address,
        user_deposit, amount_usdc, hold_deadline, create_tx, state)
     VALUES ($1,$2,$3,$4,$5,$6,$6,to_timestamp($7),$8,'Held')
     ON CONFLICT (session_id) DO UPDATE SET
       user_deposit=EXCLUDED.user_deposit, amount_usdc=EXCLUDED.amount_usdc,
       hold_deadline=EXCLUDED.hold_deadline,
       create_tx=COALESCE(EXCLUDED.create_tx, escrow_locks.create_tx), state='Held'`,
    [sessionId, escrowId, channelId, userAddress, seller, depositUsdc||'3', deadline, createTx]
  ).catch(e => logger.warn('DB insert 오류', { error: e.message }));

  return { escrowId, sessionId, depositUsdc, holdDeadline: new Date(deadline*1000).toISOString(), createTx };
}

// ── 2. settleAndRelease → releaseToSeller ────────────────────────────────────
async function settleAndRelease(sessionId, fareUsdc) {
  await ensureTable();
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const escrowId = toEscrowId(sessionId);

  let state = 0, deadline = 0, dlPassed = false;
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    state    = Number(s[0]);
    deadline = Number(s[4]);
    dlPassed = s[5];
    logger.info('settleAndRelease: 온체인', { sessionId, state: STATE_LABELS[state], dlPassed });
  } catch(e) { logger.warn('getEscrowStatus 실패', { sessionId, error: e.message }); }

  if (state === 0) {
    await getPool().query(
      `UPDATE escrow_locks SET state='SettleFailed', last_error='no_onchain_escrow' WHERE session_id=$1`,
      [sessionId]
    ).catch(()=>{});
    return { skipped: true, reason: 'no_onchain_escrow' };
  }
  if (state >= 3) return { skipped: true, reason: 'already_settled', state: STATE_LABELS[state] };
  if (state === 2) return { skipped: true, reason: 'refund_issue_pending' };

  // holdDeadline 대기
  if (!dlPassed && deadline > 0) {
    const waitMs = deadline * 1000 - Date.now();
    if (waitMs > 10000) {
      await getPool().query(
        `UPDATE escrow_locks SET state='PendingSettle', fare_amount=$2 WHERE session_id=$1`,
        [sessionId, fareUsdc||'0']
      ).catch(()=>{});
      setTimeout(async () => {
        try {
          await new Promise(r => setTimeout(r, waitMs + 2000));
          await settleAndRelease(sessionId, fareUsdc);
        } catch(e) { logger.error('BG settle 실패', { sessionId, error: e.message }); }
      }, 0);
      return { deferred: true, reason: 'pending_deadline', fareUsdc };
    } else if (waitMs > 0) {
      await new Promise(r => setTimeout(r, waitMs + 1500));
    }
  }

  let tx, receipt;
  try {
    tx      = await escrow.releaseToSeller(escrowId, { gasLimit: 200000 });
    receipt = await tx.wait();
  } catch(e) {
    logger.error('releaseToSeller revert', { sessionId, error: e.message.slice(0,200) });
    await getPool().query(
      `UPDATE escrow_locks SET state='SettleFailed', last_error=$2, retry_count=COALESCE(retry_count,0)+1 WHERE session_id=$1`,
      [sessionId, e.message.slice(0,200)]
    ).catch(()=>{});
    throw e;
  }

  await getPool().query(
    `UPDATE escrow_locks SET state='Released', settle_tx=$2, settled_at=NOW(), fare_amount=$3 WHERE session_id=$1`,
    [sessionId, receipt.hash, fareUsdc]
  ).catch(()=>{});

  logger.info('releaseToSeller OK', { sessionId, tx: receipt.hash });
  return { txHash: receipt.hash, fareUsdc, mode: 'release_to_seller' };
}

// ── 3. registerRefundIssue ───────────────────────────────────────────────────
async function registerRefundIssue(sessionId, caseId, issueType, description) {
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const escrowId = toEscrowId(sessionId);
  const num      = ISSUE_TYPE_MAP[issueType] ?? 5;
  const tx = await escrow.registerRefundIssue(escrowId, num, `${caseId}|${description}`.slice(0,200), { gasLimit: 150000 });
  await tx.wait();
  await getPool().query(`UPDATE escrow_locks SET state='RefundIssue', case_id=$2 WHERE session_id=$1`, [sessionId, caseId]).catch(()=>{});
  return { txHash: tx.hash };
}

// ── 4. refundToBuyer ─────────────────────────────────────────────────────────
async function refundToBuyer(sessionId, caseId, refundFare = '0') {
  await ensureTable();
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const escrowId = toEscrowId(sessionId);

  let state = 0;
  try { const s = await escrow.getEscrowStatus(escrowId); state = Number(s[0]); } catch(e) {}

  if (state === 0) {
    await getPool().query(`UPDATE escrow_locks SET state='Refunded', settled_at=NOW(), case_id=$2 WHERE session_id=$1`, [sessionId, caseId]).catch(()=>{});
    return { skipped: true, reason: 'no_onchain_escrow' };
  }
  if (state >= 3) return { skipped: true, reason: 'already_settled', state: STATE_LABELS[state] };

  // Held(1) → registerRefundIssue 먼저
  if (state === 1) {
    try {
      const rt = await escrow.registerRefundIssue(escrowId, 5, `${caseId}|auto`.slice(0,200), { gasLimit: 150000 });
      await rt.wait();
    } catch(e) { logger.warn('registerRefundIssue 실패', { sessionId, error: e.message }); }
  }

  const tx      = await escrow.refundToBuyer(escrowId, { gasLimit: 200000 });
  const receipt = await tx.wait();
  await getPool().query(`UPDATE escrow_locks SET state='Refunded', settle_tx=$2, settled_at=NOW(), case_id=$3 WHERE session_id=$1`, [sessionId, receipt.hash, caseId]).catch(()=>{});
  return { txHash: receipt.hash, refundFare, mode: 'refund_to_buyer' };
}

// ── 5. forceRefund (alias) ───────────────────────────────────────────────────
async function forceRefund(sessionId) { return refundToBuyer(sessionId, 'force_refund', '0'); }

// ── 6. claimSettlement (alias for 하위 호환) ─────────────────────────────────
async function claimSettlement(sessionId) { return settleAndRelease(sessionId, '0'); }

// ── 7. operatorDeposit (alias for 하위 호환) ─────────────────────────────────
async function operatorDeposit({ sessionId, userAddress, depositUsdc, holdDeadline }) {
  return recordUserDeposit({ sessionId, userAddress, depositUsdc, holdDeadline });
}

// ── 8. getEscrowStatus ───────────────────────────────────────────────────────
async function getEscrowStatus(sessionId) {
  await ensureTable();
  const escrowId = toEscrowId(sessionId);
  const dbResult = await getPool().query('SELECT * FROM escrow_locks WHERE session_id=$1', [sessionId]);
  let onChain = null;
  try {
    const s = await getEscrow(getProvider()).getEscrowStatus(escrowId);
    onChain = {
      state: STATE_LABELS[Number(s[0])], amount: (Number(s[1])/1e6).toFixed(6),
      buyer: s[2], seller: s[3], holdDeadline: Number(s[4]), isDeadlinePassed: s[5],
    };
  } catch(e) { onChain = { error: e.message }; }
  return { sessionId, escrowId, db: dbResult.rows[0]||null, onChain };
}

// ── 9. processExpiredHolds (크론) ────────────────────────────────────────────
async function processExpiredHolds() {
  await ensureTable();
  const { rows } = await getPool().query(
    `SELECT session_id, fare_amount FROM escrow_locks
      WHERE state IN ('PendingSettle','Held') AND hold_deadline < NOW()
        AND (retry_count IS NULL OR retry_count < 3) LIMIT 10`
  );
  for (const row of rows) {
    try { await settleAndRelease(row.session_id, row.fare_amount||'0'); }
    catch(e) { logger.error('processExpiredHolds 실패', { sessionId: row.session_id, error: e.message }); }
  }
  return { processed: rows.length };
}

module.exports = {
  recordUserDeposit, operatorDeposit, settleAndRelease, registerRefundIssue,
  refundToBuyer, claimSettlement, forceRefund, getEscrowStatus, processExpiredHolds, toEscrowId,
};
