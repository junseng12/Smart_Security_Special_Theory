/**
 * Escrow Payout Service — V3
 * ─────────────────────────────────────────────────────────────────────────────
 * SmartCityEscrowV3 연동 — Perun AssetHolder 원본 구조 그대로
 *
 * Perun 원본 대응:
 *   deposit(userFundingID)     → userDeposit()      (프론트 MetaMask)
 *   deposit(operatorFundingID) → operatorDeposit()  (백엔드 자동)
 *   setOutcome → withdraw      → settleAndRelease()  (백엔드, 세션 종료 시)
 *   dispute                    → forceRefund()       (사용자 직접, holdDeadline+1h 후)
 *
 * 자금 흐름:
 *   세션 시작:  user + operator 양측 예치 → FullyFunded
 *   정상 정산:  fare→operator + (userDeposit-fare)→user + operatorDeposit→operator
 *   환불:       userDeposit→user + (penalize: operatorDeposit→user or →operator)
 */

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { getPool } = require('./db');

// ── V3 ABI ────────────────────────────────────────────────────────────────────
const ESCROW_ABI_V3 = [
  // 프론트(MetaMask)가 호출
  'function userDeposit(bytes32 escrowId, address operator, uint256 amount, uint256 holdDeadline) external',
  // 백엔드(operator)가 호출
  'function operatorDeposit(bytes32 escrowId, uint256 amount) external',
  'function settleAndRelease(bytes32 escrowId, uint256 fareAmount) external',
  'function registerRefundIssue(bytes32 escrowId, uint8 issueType, string calldata description, bool penalizeOperator) external',
  'function refundToBuyer(bytes32 escrowId) external',
  'function forceRefund(bytes32 escrowId) external',
  'function emergencyCancel(bytes32 escrowId) external',
  // 조회
  'function getEscrowStatus(bytes32 escrowId) view returns (uint8 state, uint256 userDeposit, uint256 operatorDeposit, uint256 fareAmount, address user, address operator, uint256 holdDeadline, bool isFullyFunded, bool isDeadlinePassed)',
  // Events
  'event UserDeposited(bytes32 indexed escrowId, address indexed user, address indexed operator, uint256 amount, uint256 holdDeadline)',
  'event OperatorDeposited(bytes32 indexed escrowId, address indexed operator, uint256 amount)',
  'event SettledAndReleased(bytes32 indexed escrowId, address indexed operator, uint256 fare, address indexed user, uint256 refund, uint256 operatorRefund)',
  'event RefundedToBuyer(bytes32 indexed escrowId, address indexed user, uint256 amount, uint256 penalty)',
];

const USDC_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
];

const STATE_LABELS = ['None','UserDeposited','FullyFunded','RefundIssue','Released','Refunded'];

function getOperatorWallet() {
  if (!process.env.OPERATOR_PRIVATE_KEY) {
    throw new Error('OPERATOR_PRIVATE_KEY 환경변수가 설정되지 않았습니다. Railway 환경변수를 확인하세요.');
  }
  const rpc = process.env.BASE_RPC_URL || 'https://base-sepolia-rpc.publicnode.com';
  const provider = new ethers.JsonRpcProvider(rpc);
  return new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);
}

function getEscrowContract(signerOrProvider) {
  const addr = process.env.ESCROW_CONTRACT_ADDRESS;
  if (!addr) throw new Error('ESCROW_CONTRACT_ADDRESS not set');
  return new ethers.Contract(addr, ESCROW_ABI_V3, signerOrProvider);
}

// keccak256(utf8(sessionId)) — 백엔드/프론트 동일하게 사용
function toEscrowId(sessionId) {
  return ethers.keccak256(ethers.toUtf8Bytes(sessionId));
}

async function ensureEscrowTable() {
  // db.js runMigrations()에서 이미 생성 + ALTER 처리됨 — 중복 CREATE 불필요
  // NOT NULL 컬럼 호환을 위해 operator_address 기본값 보장만 수행
  await getPool().query(`
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS operator_address    TEXT;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS user_deposit        NUMERIC DEFAULT 0;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS operator_deposit    NUMERIC DEFAULT 0;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS fare_amount         NUMERIC DEFAULT 0;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS user_deposit_tx     TEXT;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS operator_deposit_tx TEXT;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS settle_tx           TEXT;
    ALTER TABLE escrow_locks ADD COLUMN IF NOT EXISTS settled_at          TIMESTAMPTZ;
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. recordUserDeposit — 프론트 userDeposit() TX 완료 후 DB 기록
// ─────────────────────────────────────────────────────────────────────────────
async function recordUserDeposit({ sessionId, channelId, userAddress, operatorAddress, depositUsdc, holdDeadline, depositTxHash }) {
  await ensureEscrowTable();
  const escrowId = toEscrowId(sessionId);
  const opAddr   = operatorAddress || process.env.OPERATOR_ADDRESS;

  await getPool().query(
    `INSERT INTO escrow_locks
     (session_id, escrow_id_bytes, channel_id, user_address, operator_address,
      user_deposit, hold_deadline, user_deposit_tx, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'UserDeposited')
     ON CONFLICT (session_id) DO UPDATE
     SET user_deposit=$6, hold_deadline=$7, user_deposit_tx=$8, state='UserDeposited', locked_at=NOW()`,
    [sessionId, escrowId, channelId, userAddress, opAddr, depositUsdc,
     new Date(holdDeadline * 1000), depositTxHash]
  );

  logger.info('User deposit recorded', { sessionId, depositUsdc, depositTxHash });
  return { escrowId };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. operatorDeposit — 백엔드가 operator 보증금 자동 예치 (Perun: operator도 deposit)
// ─────────────────────────────────────────────────────────────────────────────
async function operatorDeposit(sessionId, operatorDepositUsdc) {
  await ensureEscrowTable();

  const wallet  = getOperatorWallet();
  const escrow  = getEscrowContract(wallet);
  const escrowId = toEscrowId(sessionId);
  const amount  = ethers.parseUnits(String(operatorDepositUsdc), 6);

  // operator USDC approve → escrow
  const usdc = new ethers.Contract(
    process.env.USDC_CONTRACT_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    USDC_ABI,
    wallet
  );

  logger.info('Operator approving USDC for escrow...', { sessionId, operatorDepositUsdc });
  const approveTx = await usdc.approve(process.env.ESCROW_CONTRACT_ADDRESS, amount);
  await approveTx.wait();

  logger.info('Operator depositing to escrow...', { sessionId, operatorDepositUsdc });
  const depositTx = await escrow.operatorDeposit(escrowId, amount);
  const receipt   = await depositTx.wait();

  await getPool().query(
    `UPDATE escrow_locks
     SET operator_deposit=$2, operator_deposit_tx=$3, state='FullyFunded'
     WHERE session_id=$1`,
    [sessionId, operatorDepositUsdc, receipt.hash]
  );

  logger.info('Operator deposit complete', { sessionId, txHash: receipt.hash, operatorDepositUsdc });
  return { txHash: receipt.hash, escrowId, operatorDepositUsdc };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. settleAndRelease — 세션 종료 후 정산 (Perun setOutcome + withdraw 대응)
//    fare→operator, (deposit-fare)→user, operatorDeposit→operator
// ─────────────────────────────────────────────────────────────────────────────
async function settleAndRelease({ sessionId, fareUsdc }) {
  await ensureEscrowTable();

  const dbRes = await getPool().query(
    'SELECT * FROM escrow_locks WHERE session_id=$1', [sessionId]
  );

  if (!dbRes.rows.length) {
    // DB 레코드 없음 (userDeposit 미완료) — 스킵
    logger.warn('No escrow record for settleAndRelease, skipping', { sessionId });
    return { skipped: true, reason: 'no_escrow_record' };
  }

  const row = dbRes.rows[0];
  const holdDeadline = new Date(row.hold_deadline).getTime();
  const waitMs = holdDeadline - Date.now();

  // holdDeadline 대기 (최대 5분)
  if (waitMs > 0 && waitMs < 300000) {
    logger.info(`Waiting ${Math.ceil(waitMs/1000)}s for holdDeadline...`, { sessionId });
    await new Promise(r => setTimeout(r, waitMs + 2000));
  }

  const wallet  = getOperatorWallet();
  const escrow  = getEscrowContract(wallet);
  const escrowId = toEscrowId(sessionId);
  const fareWei  = ethers.parseUnits(String(fareUsdc || '0'), 6);

  logger.info('Calling settleAndRelease on-chain', { sessionId, fareUsdc });
  const tx      = await escrow.settleAndRelease(escrowId, fareWei);
  const receipt = await tx.wait();

  const userDeposit    = parseFloat(row.user_deposit || 0);
  const operatorDeposit = parseFloat(row.operator_deposit || 0);
  const refundUsdc     = (userDeposit - parseFloat(fareUsdc || 0)).toFixed(6);

  await getPool().query(
    `UPDATE escrow_locks
     SET state='Released', settle_tx=$2, settled_at=NOW(), fare_amount=$3
     WHERE session_id=$1`,
    [sessionId, receipt.hash, fareUsdc]
  );

  logger.info('settleAndRelease complete', { sessionId, txHash: receipt.hash, fareUsdc, refundUsdc });
  return {
    txHash: receipt.hash,
    escrowId,
    fareUsdc,
    refundUsdc,
    operatorDepositReturned: String(operatorDeposit),
    mode: 'settle_and_release_v3',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. registerRefundIssue
// ─────────────────────────────────────────────────────────────────────────────
async function registerRefundIssue(sessionId, caseId, issueType, description, penalizeOperator = false) {
  const wallet   = getOperatorWallet();
  const escrow   = getEscrowContract(wallet);
  const escrowId = toEscrowId(sessionId);
  const issueTypeMap = { unlock_failure:0, device_fault:1, wrong_charge:2, sensor_failure:3, service_outage:4, other:5 };
  const issueTypeNum = issueTypeMap[issueType] ?? 5;

  const tx = await escrow.registerRefundIssue(escrowId, issueTypeNum, `${caseId}|${description}`.slice(0,200), penalizeOperator);
  await tx.wait();

  await getPool().query(
    `UPDATE escrow_locks SET state='RefundIssue', case_id=$2 WHERE session_id=$1`,
    [sessionId, caseId]
  );
  return { txHash: tx.hash };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. refundToBuyer
// ─────────────────────────────────────────────────────────────────────────────
async function refundToBuyer(sessionId, caseId) {
  const wallet   = getOperatorWallet();
  const escrow   = getEscrowContract(wallet);
  const escrowId = toEscrowId(sessionId);

  const tx      = await escrow.refundToBuyer(escrowId);
  const receipt = await tx.wait();

  await getPool().query(
    `UPDATE escrow_locks SET state='Refunded', settle_tx=$2, settled_at=NOW(), case_id=$3
     WHERE session_id=$1`,
    [sessionId, receipt.hash, caseId]
  );

  return { txHash: receipt.hash };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. getEscrowStatus
// ─────────────────────────────────────────────────────────────────────────────
async function getEscrowStatus(sessionId) {
  await ensureEscrowTable();
  const escrowId = toEscrowId(sessionId);
  const dbResult = await getPool().query('SELECT * FROM escrow_locks WHERE session_id=$1', [sessionId]);
  const dbRow    = dbResult.rows[0] || null;

  let onChain = null;
  try {
    const rpc    = process.env.BASE_RPC_URL || 'https://base-sepolia-rpc.publicnode.com';
    const provider = new ethers.JsonRpcProvider(rpc);
    const escrow   = getEscrowContract(provider);
    const s = await escrow.getEscrowStatus(escrowId);
    onChain = {
      state:            STATE_LABELS[Number(s[0])] || 'Unknown',
      userDeposit:      (Number(s[1]) / 1e6).toFixed(6),
      operatorDeposit:  (Number(s[2]) / 1e6).toFixed(6),
      fareAmount:       (Number(s[3]) / 1e6).toFixed(6),
      user:             s[4],
      operator:         s[5],
      holdDeadline:     new Date(Number(s[6]) * 1000),
      isFullyFunded:    s[7],
      isDeadlinePassed: s[8],
    };
  } catch (err) {
    logger.warn('On-chain status fetch failed', { error: err.message });
  }

  return { db: dbRow, onChain };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. processExpiredHolds — Watchtower
// ─────────────────────────────────────────────────────────────────────────────
async function processExpiredHolds() {
  await ensureEscrowTable();
  const result = await getPool().query(`
    SELECT el.*, rc.id as case_id, rc.status as case_status, rc.approved_usdc
    FROM escrow_locks el
    LEFT JOIN refund_cases rc ON rc.session_id = el.session_id
    WHERE el.state IN ('UserDeposited','FullyFunded') AND el.hold_deadline < NOW()
  `);

  for (const lock of result.rows) {
    try {
      if (lock.case_status === 'APPROVED') {
        await refundToBuyer(lock.session_id, lock.case_id);
      } else {
        await settleAndRelease({
          sessionId: lock.session_id,
          fareUsdc: lock.fare_amount || '0',
        });
      }
    } catch (err) {
      logger.error('Failed to process expired hold', { sessionId: lock.session_id, error: err.message });
    }
  }
  logger.info('Expired escrow holds processed', { count: result.rows.length });
}

module.exports = {
  recordUserDeposit,
  operatorDeposit,
  settleAndRelease,
  registerRefundIssue,
  refundToBuyer,
  getEscrowStatus,
  processExpiredHolds,
  toEscrowId,
};
