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

// ── TX 온체인 확정 대기 ────────────────────────────────────────────────────────
async function waitForTxOnChain(txHash, timeoutMs = 90000) {
  if (!txHash || txHash.startsWith('0xmock') || txHash.startsWith('0xtest')) {
    logger.info('Mock TX hash — skip onchain wait', { txHash });
    return { status: '0x1' }; // mock 통과
  }
  const RPC_LIST = [
    process.env.BASE_RPC_URL || 'https://base-sepolia-rpc.publicnode.com',
    'https://84532.rpc.thirdweb.com',
    'https://sepolia.base.org',
  ];
  const deadline = Date.now() + timeoutMs;
  logger.info('Waiting for TX onchain...', { txHash });
  while (Date.now() < deadline) {
    for (const rpc of RPC_LIST) {
      try {
        const res = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [txHash] }),
        });
        const json = await res.json();
        if (json.result?.status) {
          if (json.result.status === '0x0') throw new Error('TX reverted on-chain: ' + txHash);
          logger.info('TX confirmed ✅', { txHash, blockNumber: json.result.blockNumber });
          return json.result;
        }
      } catch (e) {
        if (e.message.includes('reverted')) throw e;
      }
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('TX confirmation timeout: ' + txHash);
}

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

  // 기존 DB가 구버전 schema(seller_address, amount_usdc)로 생성된 경우 대비
  // 컬럼 존재 여부 확인 후 안전 INSERT
  await getPool().query(
    `ALTER TABLE escrow_locks
       ADD COLUMN IF NOT EXISTS escrow_id_bytes     TEXT,
       ADD COLUMN IF NOT EXISTS operator_address    TEXT,
       ADD COLUMN IF NOT EXISTS user_deposit        NUMERIC DEFAULT 0,
       ADD COLUMN IF NOT EXISTS operator_deposit    NUMERIC DEFAULT 0,
       ADD COLUMN IF NOT EXISTS fare_amount         NUMERIC DEFAULT 0,
       ADD COLUMN IF NOT EXISTS user_deposit_tx     TEXT,
       ADD COLUMN IF NOT EXISTS operator_deposit_tx TEXT,
       ADD COLUMN IF NOT EXISTS settle_tx           TEXT,
       ADD COLUMN IF NOT EXISTS settled_at          TIMESTAMPTZ`
  );
  // 구버전 NOT NULL 제약 제거 (seller_address, amount_usdc)
  await getPool().query(`
    ALTER TABLE escrow_locks
      ALTER COLUMN seller_address DROP NOT NULL,
      ALTER COLUMN amount_usdc    DROP NOT NULL
  `).catch(() => {}); // 컬럼 없으면 무시

  await getPool().query(
    `INSERT INTO escrow_locks
       (session_id, escrow_id_bytes, channel_id, user_address, operator_address,
        user_deposit, hold_deadline, user_deposit_tx, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'UserDeposited')
     ON CONFLICT (session_id) DO UPDATE
       SET escrow_id_bytes=$2, user_deposit=$6, hold_deadline=$7,
           user_deposit_tx=$8, operator_address=$5,
           state='UserDeposited', locked_at=NOW()`,
    [sessionId, escrowId, channelId, userAddress, opAddr,
     depositUsdc, new Date(holdDeadline * 1000), depositTxHash]
  );

  logger.info('User deposit recorded in DB', { sessionId, depositUsdc, depositTxHash });
  return { escrowId, depositTxHash };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. operatorDeposit — 백엔드가 operator 보증금 자동 예치 (Perun: operator도 deposit)
// ─────────────────────────────────────────────────────────────────────────────
async function operatorDeposit(sessionId, operatorDepositUsdc, userDepositTxHash) {
  await ensureEscrowTable();

  const escrowId = toEscrowId(sessionId);

  // ── 1. userDeposit TX 온체인 확정 대기 ────────────────────────────────────
  if (userDepositTxHash) {
    try {
      await waitForTxOnChain(userDepositTxHash, 90000);
    } catch (e) {
      logger.error('userDeposit TX 확정 실패 — operatorDeposit 중단', { sessionId, error: e.message });
      throw e;
    }
  } else {
    // txHash 없으면 3초 대기 후 state 확인
    await new Promise(r => setTimeout(r, 3000));
  }

  // ── 2. 컨트랙트 state 확인 ────────────────────────────────────────────────
  const roProvider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://base-sepolia-rpc.publicnode.com');
  const escrowRO = getEscrowContract(roProvider);
  let onchainState = 0;
  try {
    const s = await escrowRO.getEscrowStatus(escrowId);
    onchainState = Number(s[0]);
    const STATE = ['None','UserDeposited','FullyFunded','RefundIssue','Released','Refunded'];
    logger.info('Pre-operatorDeposit onchain state', { sessionId, state: STATE[onchainState] });
    if (onchainState === 0) {
      throw new Error('컨트랙트 state=None: userDeposit TX가 아직 확정되지 않음');
    }
    if (onchainState >= 2) {
      logger.info('이미 FullyFunded 이상 — operatorDeposit 스킵', { sessionId });
      return { skipped: true, reason: 'already_funded_or_settled', escrowId };
    }
  } catch (e) {
    if (!e.message.includes('None')) {
      logger.warn('getEscrowStatus 실패 — 진행', { sessionId, error: e.message });
    } else {
      throw e;
    }
  }

  // ── 3. operator USDC approve → operatorDeposit ────────────────────────────
  const wallet  = getOperatorWallet();
  const escrow  = getEscrowContract(wallet);
  const amount  = ethers.parseUnits(String(operatorDepositUsdc), 6);

  const usdc = new ethers.Contract(
    process.env.USDC_CONTRACT_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    USDC_ABI,
    wallet
  );

  logger.info('Operator approving USDC for escrow...', { sessionId, operatorDepositUsdc });
  const approveTx = await usdc.approve(process.env.ESCROW_CONTRACT_ADDRESS, amount);
  await approveTx.wait();
  logger.info('Approve ✅', { sessionId });

  logger.info('Operator depositing to escrow...', { sessionId, operatorDepositUsdc });
  const depositTx = await escrow.operatorDeposit(escrowId, amount);
  const receipt   = await depositTx.wait();

  await getPool().query(
    `UPDATE escrow_locks
     SET operator_deposit=$2, operator_deposit_tx=$3, state='FullyFunded'
     WHERE session_id=$1`,
    [sessionId, operatorDepositUsdc, receipt.hash]
  );

  logger.info('Operator deposit complete ✅', { sessionId, txHash: receipt.hash, operatorDepositUsdc });
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
  const row = dbRes.rows[0] || null;

  // ── OPERATOR_PRIVATE_KEY 없으면 온체인 정산 불가 → DB 기록만 ──
  if (!process.env.OPERATOR_PRIVATE_KEY || !process.env.ESCROW_CONTRACT_ADDRESS) {
    logger.warn('Escrow env 미설정 — DB 기록만 처리', { sessionId });
    if (row) {
      await getPool().query(
        `UPDATE escrow_locks SET state='Released', settled_at=NOW(), fare_amount=$2 WHERE session_id=$1`,
        [sessionId, fareUsdc || '0']
      );
    }
    return { skipped: true, reason: 'env_not_configured', fareUsdc };
  }

  if (!row) {
    logger.warn('No escrow record for settleAndRelease — DB only', { sessionId });
    return { skipped: true, reason: 'no_escrow_record' };
  }

  // ── holdDeadline 대기 ──
  // DB hold_deadline = 컨트랙트에 등록된 값과 동일해야 함 (백엔드 /start 기준)
  const holdDeadline = new Date(row.hold_deadline).getTime();
  const waitMs = holdDeadline - Date.now();

  if (waitMs > 0) {
    const capMs = Math.min(waitMs + 2000, 300000); // 최대 5분 대기
    logger.info(`HoldDeadline 대기 ${Math.ceil(capMs/1000)}s`, { sessionId });
    await new Promise(r => setTimeout(r, capMs));
  }

  const wallet   = getOperatorWallet();
  const escrow   = getEscrowContract(wallet);
  const escrowId = toEscrowId(sessionId);
  const fareWei  = ethers.parseUnits(String(fareUsdc || '0'), 6);

  // ── 온체인 getEscrowStatus로 상태 확인 후 호출 ──
  let onchainStatus = null;
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    onchainStatus = { state: Number(s[0]), userDeposit: s[1], operatorDeposit: s[2] };
    logger.info('On-chain escrow status', { sessionId, state: STATE_LABELS[onchainStatus.state] });

    // 이미 Released/Refunded면 스킵
    if (onchainStatus.state >= 4) {
      logger.info('Already settled on-chain, skip', { sessionId });
      return { skipped: true, reason: 'already_settled', onchainState: STATE_LABELS[onchainStatus.state] };
    }
    // None이면 userDeposit 안 된 것 → 스킵
    if (onchainStatus.state === 0) {
      logger.warn('Escrow state is None on-chain — userDeposit 미완료', { sessionId });
      return { skipped: true, reason: 'no_onchain_deposit' };
    }
  } catch (statusErr) {
    logger.warn('getEscrowStatus 실패 — 상태 확인 없이 진행', { sessionId, error: statusErr.message });
  }

  logger.info('Calling settleAndRelease on-chain', { sessionId, fareUsdc });
  const tx      = await escrow.settleAndRelease(escrowId, fareWei);
  const receipt = await tx.wait();

  const userDep  = parseFloat(row.user_deposit || 0);
  const opDep    = parseFloat(row.operator_deposit || 0);
  const refundUsdc = (userDep - parseFloat(fareUsdc || 0)).toFixed(6);

  await getPool().query(
    `UPDATE escrow_locks SET state='Released', settle_tx=$2, settled_at=NOW(), fare_amount=$3 WHERE session_id=$1`,
    [sessionId, receipt.hash, fareUsdc]
  );

  logger.info('settleAndRelease complete ✅', { sessionId, txHash: receipt.hash, fareUsdc, refundUsdc });
  return {
    txHash: receipt.hash,
    escrowId,
    fareUsdc,
    refundUsdc,
    operatorDepositReturned: String(opDep),
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
