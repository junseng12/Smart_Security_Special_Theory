/**
 * Escrow Payout Service
 * ─────────────────────────────────────────────────────────────────────────────
 * SmartCityEscrow 컨트랙트와 연동하는 백엔드 서비스
 *
 * 컨트랙트 함수 대응:
 *   createEscrow()          → lockFundsInEscrow()
 *   registerRefundIssue()   → registerRefundIssue()
 *   releaseToSeller()       → releaseToSeller()
 *   refundToBuyer()         → refundToBuyer()
 *   getEscrowStatus()       → getEscrowStatus()
 *
 * 이벤트 수신 (백엔드 동기화):
 *   EscrowCreated           → DB escrow_locks 생성
 *   RefundIssueRegistered   → DB 상태 업데이트
 *   ReleasedToSeller        → DB released 처리
 *   RefundedToBuyer         → DB refunded 처리 + 케이스 종결
 */

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const { getPool } = require('./db');
const caseManager = require('./refundCaseManager');

// ── Contract ABI ──────────────────────────────────────────────────────────────
const ESCROW_ABI = [
  // Write
  'function createEscrow(bytes32 escrowId, address buyer, address seller, uint256 amount, uint256 holdDeadline) external',
  'function registerRefundIssue(bytes32 escrowId, uint8 issueType, string calldata description) external',
  'function releaseToSeller(bytes32 escrowId) external',
  'function refundToBuyer(bytes32 escrowId) external',
  'function emergencyCancel(bytes32 escrowId) external',
  // Read
  'function getEscrowStatus(bytes32 escrowId) view returns (uint8 state, uint256 amount, address buyer, address seller, uint256 holdDeadline, bool isDeadlinePassed)',
  'function getIssueRecord(bytes32 escrowId) view returns (uint8 issueType, string description, uint256 registeredAt)',
  'function isDeadlinePassed(bytes32 escrowId) view returns (bool)',
  // Events
  'event EscrowCreated(bytes32 indexed escrowId, address indexed buyer, address indexed seller, uint256 amount, uint256 holdDeadline)',
  'event RefundIssueRegistered(bytes32 indexed escrowId, uint8 issueType, string description, uint256 registeredAt)',
  'event ReleasedToSeller(bytes32 indexed escrowId, address indexed seller, uint256 amount)',
  'event RefundedToBuyer(bytes32 indexed escrowId, address indexed buyer, uint256 amount)',
];

// IssueType enum 매핑
const ISSUE_TYPE = {
  unlock_failure: 0,
  device_fault:   1,
  wrong_charge:   2,
  sensor_failure: 3,
  service_outage: 4,
  other:          5,
};

const HOLD_PERIOD_SECONDS = 24 * 60 * 60; // 24시간

// ── 헬퍼 ─────────────────────────────────────────────────────────────────────

function getOperatorWallet() {
  const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
  return new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);
}

function getEscrowContract(signerOrProvider) {
  const addr = process.env.ESCROW_CONTRACT_ADDRESS;
  if (!addr) throw new Error('ESCROW_CONTRACT_ADDRESS not set');
  return new ethers.Contract(addr, ESCROW_ABI, signerOrProvider);
}

/** sessionId → bytes32 escrowId 변환 */
function toEscrowId(sessionId) {
  // 32바이트로 맞추기 위해 keccak256 사용
  return ethers.keccak256(ethers.toUtf8Bytes(sessionId));
}

// ── DB 마이그레이션 ────────────────────────────────────────────────────────────
async function ensureEscrowTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS escrow_locks (
      id               SERIAL PRIMARY KEY,
      session_id       TEXT NOT NULL UNIQUE,
      escrow_id_bytes  TEXT NOT NULL,
      channel_id       TEXT,
      case_id          TEXT,
      user_address     TEXT NOT NULL,
      seller_address   TEXT NOT NULL,
      amount_usdc      NUMERIC NOT NULL,
      hold_deadline    TIMESTAMPTZ NOT NULL,
      create_tx        TEXT,
      release_tx       TEXT,
      state            TEXT NOT NULL DEFAULT 'Held',
      locked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      released_at      TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_escrow_session ON escrow_locks(session_id);
    CREATE INDEX IF NOT EXISTS idx_escrow_state   ON escrow_locks(state);
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. createEscrow — Perun 정산 완료 후 Seller 지급 예정 금액 Escrow에 잠금
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.channelId
 * @param {string} params.buyerAddress     - 사용자 (환불 수신 가능)
 * @param {string} params.sellerAddress    - 운영자/판매자 (정상 지급 수신)
 * @param {string} params.amountUsdc      - 잠글 금액
 * @param {number} [params.holdSeconds]   - Hold 기간 (기본 24h)
 */
async function createEscrow({ sessionId, channelId, buyerAddress, sellerAddress, amountUsdc, holdSeconds = HOLD_PERIOD_SECONDS }) {
  await ensureEscrowTable();

  const wallet  = getOperatorWallet();
  const escrow  = getEscrowContract(wallet);
  const escrowId = toEscrowId(sessionId);
  const amountWei = ethers.parseUnits(amountUsdc, 6);
  const holdDeadline = Math.floor(Date.now() / 1000) + holdSeconds;

  logger.info('Creating escrow', { sessionId, escrowId, amountUsdc, holdDeadline });

  // USDC approve → createEscrow 순서
  const usdcContract = new ethers.Contract(
    process.env.USDC_CONTRACT_ADDRESS,
    ['function approve(address spender, uint256 amount) returns (bool)'],
    wallet
  );
  const approveTx = await usdcContract.approve(process.env.ESCROW_CONTRACT_ADDRESS, amountWei);
  await approveTx.wait();

  const tx = await escrow.createEscrow(escrowId, buyerAddress, sellerAddress, amountWei, holdDeadline);
  const receipt = await tx.wait();

  const holdDeadlineDate = new Date(holdDeadline * 1000);

  await getPool().query(
    `INSERT INTO escrow_locks
     (session_id, escrow_id_bytes, channel_id, user_address, seller_address, amount_usdc, hold_deadline, create_tx, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Held')
     ON CONFLICT (session_id) DO UPDATE
     SET create_tx = $8, locked_at = NOW(), state = 'Held'`,
    [sessionId, escrowId, channelId, buyerAddress, sellerAddress, amountUsdc, holdDeadlineDate, receipt.hash]
  );

  logger.info('Escrow created', { sessionId, txHash: receipt.hash, holdDeadline: holdDeadlineDate });
  return { txHash: receipt.hash, escrowId, holdDeadline: holdDeadlineDate };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. registerRefundIssue — 문제 발생 기록
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {string} sessionId
 * @param {string} caseId           - 백엔드 환불 케이스 ID
 * @param {string} issueType        - ISSUE_TYPE 키 (예: 'sensor_failure')
 * @param {string} description      - 문제 설명
 */
async function registerRefundIssue(sessionId, caseId, issueType, description) {
  const wallet  = getOperatorWallet();
  const escrow  = getEscrowContract(wallet);
  const escrowId = toEscrowId(sessionId);

  const issueTypeNum = ISSUE_TYPE[issueType] ?? ISSUE_TYPE.other;
  const desc = `${caseId}|${description}`.slice(0, 200); // 컨트랙트 string 제한 고려

  logger.info('Registering refund issue on-chain', { sessionId, issueType, caseId });

  const tx = await escrow.registerRefundIssue(escrowId, issueTypeNum, desc);
  await tx.wait();

  await getPool().query(
    `UPDATE escrow_locks SET state = 'RefundIssue', case_id = $2 WHERE session_id = $1`,
    [sessionId, caseId]
  );

  logger.info('Refund issue registered on-chain', { sessionId });
  return { txHash: tx.hash };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. releaseToSeller — 문제 없음 + holdDeadline 경과 → Seller에게 즉시 송금
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {string} sessionId
 */
async function releaseToSeller(sessionId) {
  const wallet  = getOperatorWallet();
  const escrow  = getEscrowContract(wallet);
  const escrowId = toEscrowId(sessionId);

  // holdDeadline 확인 (컨트랙트에서도 revert하지만 미리 체크)
  const isPassed = await escrow.isDeadlinePassed(escrowId);
  if (!isPassed) {
    throw new Error(`Hold deadline not yet passed for session ${sessionId}`);
  }

  logger.info('Releasing escrow to seller', { sessionId });

  const tx = await escrow.releaseToSeller(escrowId);
  const receipt = await tx.wait();

  await getPool().query(
    `UPDATE escrow_locks
     SET state = 'Released', release_tx = $2, released_at = NOW()
     WHERE session_id = $1`,
    [sessionId, receipt.hash]
  );

  logger.info('Escrow released to seller', { sessionId, txHash: receipt.hash });
  return { txHash: receipt.hash };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. refundToBuyer — 문제 확인 → Buyer에게 즉시 환불
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {string} sessionId
 * @param {string} caseId    - 연결된 환불 케이스 ID
 */
async function refundToBuyer(sessionId, caseId) {
  const wallet  = getOperatorWallet();
  const escrow  = getEscrowContract(wallet);
  const escrowId = toEscrowId(sessionId);

  logger.info('Refunding escrow to buyer', { sessionId, caseId });

  const tx = await escrow.refundToBuyer(escrowId);
  const receipt = await tx.wait();

  await getPool().query(
    `UPDATE escrow_locks
     SET state = 'Refunded', release_tx = $2, released_at = NOW(), case_id = $3
     WHERE session_id = $1`,
    [sessionId, receipt.hash, caseId]
  );

  // 케이스 지급 완료 → 종결
  if (caseId) {
    await caseManager.markPaid(caseId);
    await caseManager.closeCase(caseId);
  }

  logger.info('Buyer refunded from escrow', { sessionId, txHash: receipt.hash });
  return { txHash: receipt.hash };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. getEscrowStatus — 상태 조회
// ─────────────────────────────────────────────────────────────────────────────
const STATE_LABELS = ['None', 'Held', 'RefundIssue', 'Released', 'Refunded'];

async function getEscrowStatus(sessionId) {
  await ensureEscrowTable();

  // DB 조회
  const dbResult = await getPool().query(
    'SELECT * FROM escrow_locks WHERE session_id = $1',
    [sessionId]
  );
  const dbRow = dbResult.rows[0] || null;

  // 온체인 상태도 조회 (컨트랙트 주소가 있는 경우)
  let onChain = null;
  if (process.env.ESCROW_CONTRACT_ADDRESS) {
    try {
      const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
      const escrow   = getEscrowContract(provider);
      const escrowId = toEscrowId(sessionId);
      const [state, amount, buyer, seller, holdDeadline, isDeadlinePassed] =
        await escrow.getEscrowStatus(escrowId);

      onChain = {
        state:           STATE_LABELS[Number(state)] || 'Unknown',
        amount:          ethers.formatUnits(amount, 6),
        buyer,
        seller,
        holdDeadline:    new Date(Number(holdDeadline) * 1000),
        isDeadlinePassed,
      };
    } catch (err) {
      logger.warn('On-chain escrow status fetch failed', { error: err.message });
    }
  }

  return { db: dbRow, onChain };
}

// ─────────────────────────────────────────────────────────────────────────────
// Watchtower: holdDeadline 만료된 Held 에스크로 자동 처리
// ─────────────────────────────────────────────────────────────────────────────
async function processExpiredHolds() {
  await ensureEscrowTable();

  const result = await getPool().query(`
    SELECT el.*, rc.id as case_id, rc.status as case_status
    FROM escrow_locks el
    LEFT JOIN refund_cases rc ON rc.session_id = el.session_id
    WHERE el.state = 'Held'
      AND el.hold_deadline < NOW()
  `);

  for (const lock of result.rows) {
    try {
      // RefundIssue 케이스가 APPROVED면 → 환불
      if (lock.case_status === 'APPROVED') {
        await refundToBuyer(lock.session_id, lock.case_id);
      } else {
        // 이슈 없음 → Seller 지급
        await releaseToSeller(lock.session_id);
      }
    } catch (err) {
      logger.error('Failed to process expired hold', { sessionId: lock.session_id, error: err.message });
    }
  }

  logger.info('Expired escrow holds processed', { count: result.rows.length });
}

module.exports = {
  createEscrow,
  registerRefundIssue,
  releaseToSeller,
  refundToBuyer,
  getEscrowStatus,
  processExpiredHolds,
  toEscrowId,
  ISSUE_TYPE,
};
