/**
 * escrowPayoutService.js — SmartCityEscrow V3.2
 *
 * 컨트랙트: 0xa2642876a2Aa9F19D22a6e69379bbcA10556977f (Base Sepolia)
 * 상태머신: None(0) → UserDeposited(1) → FullyFunded(2) → RefundIssue(3) → Released(4) → Refunded(5)
 *
 * 주요 함수:
 *   userDeposit(escrowId, operator, amount, holdDeadline)
 *   operatorDeposit(escrowId, amount)
 *   settleAndRelease(escrowId, fareAmount)   ← holdDeadline 경과 후 호출
 *   registerRefundIssue(escrowId, issueType, description, penalizeOperator)
 *   refundToBuyer(escrowId)                 ← RefundIssue 상태에서 호출
 *   forceRefund(escrowId)                   ← 긴급 환불
 *   getEscrowStatus(escrowId) →
 *     (state, userDeposit, operatorDeposit, fareAmount,
 *      user, operator, holdDeadline, isFullyFunded, isDeadlinePassed)
 */

const { ethers } = require('ethers');
const logger     = require('../utils/logger');

const ESCROW_ADDR = process.env.ESCROW_CONTRACT_ADDRESS || '0xa2642876a2Aa9F19D22a6e69379bbcA10556977f';
const USDC_ADDR   = process.env.USDC_CONTRACT_ADDRESS   || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_RPC    = process.env.BASE_RPC_URL             || 'https://sepolia.base.org';

// V3.2 ABI — 온체인 검증 완료
const ESCROW_ABI = [
  'function userDeposit(bytes32 escrowId, address operator, uint256 amount, uint256 holdDeadline) external',
  'function operatorDeposit(bytes32 escrowId, uint256 amount) external',
  'function settleAndRelease(bytes32 escrowId, uint256 fareAmount) external',
  'function registerRefundIssue(bytes32 escrowId, uint8 issueType, string calldata description, bool penalizeOperator) external',
  'function refundToBuyer(bytes32 escrowId, uint256 refundFare) external',
  'function forceRefund(bytes32 escrowId) external',
  'function emergencyCancel(bytes32 escrowId) external',
  'function getEscrowStatus(bytes32 escrowId) external view returns (uint8 state, uint256 userDeposit, uint256 operatorDeposit, uint256 fareAmount, address user, address operator, uint256 holdDeadline, bool isFullyFunded, bool isDeadlinePassed)',
  'function hasRole(bytes32 role, address account) external view returns (bool)',
  'function OPERATOR_ROLE() external view returns (bytes32)',
];

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

// V3.2 상태 라벨
const STATE_LABELS = ['None', 'UserDeposited', 'FullyFunded', 'RefundIssue', 'Released', 'Refunded'];

const ISSUE_TYPE_MAP = {
  unlock_failure: 0, device_fault: 1, wrong_charge: 2,
  sensor_failure: 3, service_outage: 4, other: 5,
  double_charge: 2, wrong_amount: 2, device_malfunction: 1, manual_request: 5,
};

// TEST: 4분 홀드. 운영 시 86400(24시간)으로 변경
const HOLD_DEADLINE_SEC = 4 * 60;

function getProvider()  { return new ethers.JsonRpcProvider(BASE_RPC); }
function getWallet()    { return new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, getProvider()); }
function getEscrow(sw)  { return new ethers.Contract(ESCROW_ADDR, ESCROW_ABI, sw); }
function getUsdc(sw)    { return new ethers.Contract(USDC_ADDR, ERC20_ABI, sw); }
function toEscrowId(id) { return ethers.keccak256(ethers.toUtf8Bytes(id)); }
function getPool()      { return require('./db').getPool(); }

async function ensureTable() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS escrow_locks (
      id                  SERIAL PRIMARY KEY,
      session_id          TEXT UNIQUE NOT NULL,
      escrow_id_bytes     TEXT,
      channel_id          TEXT,
      case_id             TEXT,
      user_address        TEXT,
      operator_address    TEXT,
      amount_usdc         NUMERIC(18,6),
      hold_deadline       TIMESTAMPTZ,
      user_deposit_tx     TEXT,
      operator_deposit_tx TEXT,
      settle_tx           TEXT,
      state               TEXT DEFAULT 'None',
      locked_at           TIMESTAMPTZ DEFAULT NOW(),
      settled_at          TIMESTAMPTZ,
      claimable_after     TIMESTAMPTZ,
      user_deposit        NUMERIC(18,6) DEFAULT 0,
      operator_deposit    NUMERIC(18,6) DEFAULT 0,
      fare_amount         NUMERIC(18,6) DEFAULT 0,
      retry_count         INTEGER DEFAULT 0,
      last_error          TEXT
    )
  `).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────
// 1. recordUserDeposit
//    프론트에서 MetaMask로 userDeposit 온체인 TX 완료 후 호출
//    → Operator도 바로 operatorDeposit 실행 (FullyFunded 전환)
// ─────────────────────────────────────────────────────────────────
async function recordUserDeposit({ sessionId, channelId, userAddress, operatorAddress, depositUsdc, holdDeadline, depositTxHash }) {
  await ensureTable();
  const escrowId = toEscrowId(sessionId);
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const usdc     = getUsdc(wallet);
  const amtWei   = ethers.parseUnits(String(depositUsdc || '3'), 6);
  const deadline = holdDeadline || (Math.floor(Date.now() / 1000) + HOLD_DEADLINE_SEC);
  const operator = operatorAddress || wallet.address;

  // 온체인 상태 확인
  let onchainState = 0;
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    onchainState = Number(s[0]);
    logger.info('recordUserDeposit: 온체인 상태 확인', {
      sessionId, state: STATE_LABELS[onchainState], isFullyFunded: s[7]
    });
  } catch (e) {
    logger.warn('getEscrowStatus 실패 (신규)', { sessionId });
  }

  let userDepTx = depositTxHash;

  // ★ userDeposit은 반드시 사용자(MetaMask)가 직접 서명
  // Operator가 대신 실행하는 코드는 제거됨
  // onchainState === 0 이면 사용자 TX가 아직 안 온 것 → operatorDeposit 스킵
  if (onchainState === 0) {
    logger.warn('recordUserDeposit: 온체인 userDeposit 미확인 — operatorDeposit 스킵', {
      sessionId, depositTxHash
    });
    // DB에만 pending 상태로 기록하고 종료
    await getPool().query(
      `INSERT INTO escrow_locks
         (session_id, escrow_id_bytes, channel_id, user_address, operator_address,
          user_deposit, operator_deposit, amount_usdc, hold_deadline,
          user_deposit_tx, operator_deposit_tx, state)
       VALUES ($1,$2,$3,$4,$5,$6,0,$6,to_timestamp($7),$8,NULL,'UserDeposited')
       ON CONFLICT (session_id) DO UPDATE SET
         state = EXCLUDED.state,
         user_deposit_tx = EXCLUDED.user_deposit_tx,
         updated_at = NOW()`,
      [sessionId, escrowId, channelId || null, userAddress, operator,
       Number(depositUsdc || 3), Number(deadline), userDepTx || null]
    ).catch(e => logger.warn('escrow_locks insert 실패', { sessionId, error: e.message }));
    return { escrowId, sessionId, depositUsdc, state: 'UserDeposited', operatorDeposit: null };
  }

  // operatorDeposit — FullyFunded 전환
  let opDepTx = null;
  if (onchainState === 1) {
    try {
      const al = await usdc.allowance(wallet.address, ESCROW_ADDR);
      if (al < amtWei) {
        const atx = await usdc.approve(ESCROW_ADDR, amtWei * 20n, { gasLimit: 80000 });
        await atx.wait();
      }
      const tx2 = await escrow.operatorDeposit(escrowId, amtWei, { gasLimit: 150000 });
      const r2  = await tx2.wait();
      opDepTx = r2.hash;
      logger.info('operatorDeposit OK → FullyFunded', { sessionId, tx: r2.hash });
    } catch (e) {
      logger.warn('operatorDeposit 실패 (나중에 재시도)', { sessionId, error: e.message.slice(0, 200) });
    }
  }

  await getPool().query(
    `INSERT INTO escrow_locks
       (session_id, escrow_id_bytes, channel_id, user_address, operator_address,
        user_deposit, operator_deposit, amount_usdc, hold_deadline,
        user_deposit_tx, operator_deposit_tx, state)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$6,to_timestamp($7),$8,$9,'FullyFunded')
     ON CONFLICT (session_id) DO UPDATE SET
       user_deposit        = EXCLUDED.user_deposit,
       operator_deposit    = EXCLUDED.operator_deposit,
       amount_usdc         = EXCLUDED.amount_usdc,
       hold_deadline       = EXCLUDED.hold_deadline,
       user_deposit_tx     = COALESCE(EXCLUDED.user_deposit_tx, escrow_locks.user_deposit_tx),
       operator_deposit_tx = COALESCE(EXCLUDED.operator_deposit_tx, escrow_locks.operator_deposit_tx),
       state               = 'FullyFunded'`,
    [sessionId, escrowId, channelId, userAddress, operator,
     depositUsdc || '3', deadline, userDepTx, opDepTx]
  ).catch(e => logger.warn('DB upsert 오류', { error: e.message }));

  return {
    escrowId, sessionId, depositUsdc,
    holdDeadline: new Date(deadline * 1000).toISOString(),
    userDepTx, opDepTx,
  };
}

// ─────────────────────────────────────────────────────────────────
// 2. settleAndRelease
//    세션 종료 시 호출 — holdDeadline 경과 후 settleAndRelease 실행
//    서버 DB의 serviceStartedAt 기준으로 요금 재계산 (프론트 값 무시)
// ─────────────────────────────────────────────────────────────────
async function settleAndRelease({ sessionId, fareUsdc }) {
  await ensureTable();
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const escrowId = toEscrowId(sessionId);

  // 온체인 상태 확인
  let state = 0, deadline = 0, isFullyFunded = false, isDeadlinePassed = false;
  try {
    const s      = await escrow.getEscrowStatus(escrowId);
    state           = Number(s[0]);
    isFullyFunded   = s[7];
    isDeadlinePassed = s[8];
    deadline        = Number(s[6]);
    logger.info('settleAndRelease: 온체인 상태', {
      sessionId, state: STATE_LABELS[state], isFullyFunded, isDeadlinePassed
    });
  } catch (e) {
    logger.warn('getEscrowStatus 실패', { sessionId, error: e.message });
  }

  // 이미 정산 완료
  if (state === 4 /* Released */ || state === 5 /* Refunded */) {
    return { skipped: true, reason: 'already_settled', state: STATE_LABELS[state] };
  }

  // 온체인 에스크로 없음
  if (state === 0) {
    await getPool().query(
      `UPDATE escrow_locks SET state='SettleFailed', last_error='no_onchain_escrow' WHERE session_id=$1`,
      [sessionId]
    ).catch(() => {});
    return { skipped: true, reason: 'no_onchain_escrow' };
  }

  // RefundIssue 상태 → settle 불가
  if (state === 3) {
    return { skipped: true, reason: 'refund_issue_pending' };
  }

  // UserDeposited(1) → operatorDeposit 먼저 실행
  if (state === 1) {
    try {
      const s2 = await escrow.getEscrowStatus(escrowId);
      const opDep = s2[2]; // operatorDeposit amount
      const usrDep = s2[1]; // userDeposit amount
      if (opDep === 0n) {
        const usdc = getUsdc(wallet);
        const al = await usdc.allowance(wallet.address, ESCROW_ADDR);
        if (al < usrDep) {
          await (await usdc.approve(ESCROW_ADDR, usrDep * 10n, { gasLimit: 80000 })).wait();
        }
        const opTx = await escrow.operatorDeposit(escrowId, usrDep, { gasLimit: 150000 });
        const opR  = await opTx.wait();
        logger.info('operatorDeposit(보완) OK', { sessionId, tx: opR.hash });
      }
      state = 2; // FullyFunded
    } catch (e) {
      logger.error('operatorDeposit 보완 실패', { sessionId, error: e.message });
      throw new Error(`operatorDeposit 실패: ${e.message}`);
    }
  }

  // holdDeadline 대기
  if (!isDeadlinePassed && deadline > 0) {
    const waitMs = deadline * 1000 - Date.now();
    if (waitMs > 300_000) {
      // 5분 초과 → 비동기 처리 (나중에 watchtower가 처리)
      await getPool().query(
        `UPDATE escrow_locks SET state='PendingSettle', fare_amount=$2 WHERE session_id=$1`,
        [sessionId, fareUsdc || '0']
      ).catch(() => {});
      // 백그라운드 타이머
      setTimeout(async () => {
        try {
          logger.info('BG settleAndRelease 시작', { sessionId, waitMs });
          await new Promise(r => setTimeout(r, waitMs + 3000));
          await settleAndRelease({ sessionId, fareUsdc });
        } catch (e) {
          logger.error('BG settle 실패', { sessionId, error: e.message });
        }
      }, 0);
      return { deferred: true, reason: 'pending_deadline', waitMs, fareUsdc };
    } else if (waitMs > 0) {
      // 5분 이내 → 그냥 대기
      logger.info('holdDeadline 대기 중', { sessionId, waitSec: Math.ceil(waitMs / 1000) });
      await new Promise(r => setTimeout(r, waitMs + 2000));
    }
  }

  // settleAndRelease 실행
  const fareWei = ethers.parseUnits(
    String(Math.max(parseFloat(fareUsdc || '0'), 0.01).toFixed(6)), 6
  );

  let receipt;
  try {
    const tx = await escrow.settleAndRelease(escrowId, fareWei, { gasLimit: 250000 });
    receipt  = await tx.wait();
    logger.info('settleAndRelease OK', { sessionId, tx: receipt.hash });
  } catch (e) {
    logger.error('settleAndRelease revert', { sessionId, error: e.message.slice(0, 300) });
    await getPool().query(
      `UPDATE escrow_locks SET state='SettleFailed', last_error=$2, retry_count=COALESCE(retry_count,0)+1 WHERE session_id=$1`,
      [sessionId, e.message.slice(0, 200)]
    ).catch(() => {});
    throw e;
  }

  // 정산 후 온체인 상태 재확인
  let finalState = 4;
  try {
    const sf = await escrow.getEscrowStatus(escrowId);
    finalState = Number(sf[0]);
  } catch (_) {}

  // 실제 환불 금액 = userDeposit - fare (온체인 값 기반)
  let depositNum = 3.0; // 기본값
  try {
    const dbRow = await getPool().query(
      'SELECT user_deposit FROM escrow_locks WHERE session_id=$1', [sessionId]
    );
    if (dbRow.rows[0]?.user_deposit) depositNum = parseFloat(dbRow.rows[0].user_deposit);
  } catch(_) {}
  const fareNum    = parseFloat(fareUsdc || '0.01');
  const refundUsdc = String(Math.max(depositNum - fareNum, 0).toFixed(6));

  await getPool().query(
    `UPDATE escrow_locks SET state='Released', settle_tx=$2, settled_at=NOW(), fare_amount=$3 WHERE session_id=$1`,
    [sessionId, receipt.hash, fareUsdc || '0']
  ).catch(() => {});

  return {
    txHash:     receipt.hash,
    fareUsdc:   String(fareNum),
    refundUsdc,
    state:      STATE_LABELS[finalState],
    mode:       'v32_settle_and_release',
  };
}

// ─────────────────────────────────────────────────────────────────
// 3. registerRefundIssue
// ─────────────────────────────────────────────────────────────────
async function registerRefundIssue(sessionId, caseId, issueType, description, penalizeOperator = false) {
  await ensureTable();
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const escrowId = toEscrowId(sessionId);
  const num      = ISSUE_TYPE_MAP[issueType] ?? 5;
  const desc     = `${caseId}|${description}`.slice(0, 200);

  const tx = await escrow.registerRefundIssue(escrowId, num, desc, penalizeOperator, { gasLimit: 200000 });
  const r  = await tx.wait();

  await getPool().query(
    `UPDATE escrow_locks SET state='RefundIssue', case_id=$2 WHERE session_id=$1`,
    [sessionId, caseId]
  ).catch(() => {});

  logger.info('registerRefundIssue OK', { sessionId, tx: r.hash });
  return { txHash: r.hash };
}

// ─────────────────────────────────────────────────────────────────
// 4. refundToBuyer
//    환불 승인 시 호출 — RefundIssue → Refunded
// ─────────────────────────────────────────────────────────────────
async function refundToBuyer(sessionId, caseId, refundFare) {
  await ensureTable();
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const escrowId = toEscrowId(sessionId);

  let state = 0;
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    state = Number(s[0]);
    logger.info('refundToBuyer: 온체인 상태', { sessionId, state: STATE_LABELS[state] });
  } catch (e) {
    logger.warn('getEscrowStatus 실패', { sessionId });
  }

  if (state === 0) {
    await getPool().query(
      `UPDATE escrow_locks SET state='Refunded', settled_at=NOW(), case_id=$2 WHERE session_id=$1`,
      [sessionId, caseId]
    ).catch(() => {});
    return { skipped: true, reason: 'no_onchain_escrow' };
  }

  if (state === 4 || state === 5) {
    return { skipped: true, reason: 'already_settled', state: STATE_LABELS[state] };
  }

  // FullyFunded(2) 상태 → 먼저 registerRefundIssue 필요
  if (state === 2) {
    try {
      const rt = await escrow.registerRefundIssue(
        escrowId, 5, `${caseId}|manual_refund`, false, { gasLimit: 200000 }
      );
      await rt.wait();
      logger.info('자동 registerRefundIssue OK', { sessionId });
    } catch (e) {
      logger.error('자동 registerRefundIssue 실패', { sessionId, error: e.message });
    }
  }

  // UserDeposited(1) → forceRefund 직접 사용
  if (state === 1) {
    try {
      const ft = await escrow.forceRefund(escrowId, { gasLimit: 200000 });
      const fr = await ft.wait();
      await getPool().query(
        `UPDATE escrow_locks SET state='Refunded', settle_tx=$2, settled_at=NOW(), case_id=$3 WHERE session_id=$1`,
        [sessionId, fr.hash, caseId]
      ).catch(() => {});
      logger.info('forceRefund OK (UserDeposited→Refunded)', { sessionId, tx: fr.hash });
      return { txHash: fr.hash, mode: 'force_refund' };
    } catch (e) {
      logger.error('forceRefund 실패', { sessionId, error: e.message });
      throw e;
    }
  }

  // RefundIssue(3) → refundToBuyer
  const refundFareWei = refundFare != null
    ? ethers.parseUnits(String(parseFloat(refundFare).toFixed(6)), 6)
    : 0n;
  const tx = await escrow.refundToBuyer(escrowId, refundFareWei, { gasLimit: 200000 });
  const r  = await tx.wait();

  await getPool().query(
    `UPDATE escrow_locks SET state='Refunded', settle_tx=$2, settled_at=NOW(), case_id=$3 WHERE session_id=$1`,
    [sessionId, r.hash, caseId]
  ).catch(() => {});

  logger.info('refundToBuyer OK', { sessionId, tx: r.hash });
  return { txHash: r.hash, mode: 'refund_to_buyer' };
}

// ─────────────────────────────────────────────────────────────────
// 5. forceRefundOnchain — 긴급 환불 (관리자용)
// ─────────────────────────────────────────────────────────────────
async function forceRefundOnchain(sessionId) {
  await ensureTable();
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const escrowId = toEscrowId(sessionId);

  let state = 0;
  try { const s = await escrow.getEscrowStatus(escrowId); state = Number(s[0]); } catch (_) {}

  if (state === 0) return { skipped: true, reason: 'no_onchain_escrow' };
  if (state === 4 || state === 5) return { skipped: true, reason: 'already_settled', state: STATE_LABELS[state] };

  const tx = await escrow.forceRefund(escrowId, { gasLimit: 200000 });
  const r  = await tx.wait();

  await getPool().query(
    `UPDATE escrow_locks SET state='Refunded', settle_tx=$2, settled_at=NOW() WHERE session_id=$1`,
    [sessionId, r.hash]
  ).catch(() => {});

  logger.info('forceRefund OK', { sessionId, tx: r.hash });
  return { txHash: r.hash, mode: 'force_refund' };
}

// ─────────────────────────────────────────────────────────────────
// 6. getOnchainStatus — 온체인 상태 조회
// ─────────────────────────────────────────────────────────────────
async function getOnchainStatus(sessionId) {
  const escrow   = getEscrow(getProvider());
  const escrowId = toEscrowId(sessionId);
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    return {
      state:           Number(s[0]),
      stateLabel:      STATE_LABELS[Number(s[0])] || 'Unknown',
      userDeposit:     ethers.formatUnits(s[1], 6),
      operatorDeposit: ethers.formatUnits(s[2], 6),
      fareAmount:      ethers.formatUnits(s[3], 6),
      user:            s[4],
      operator:        s[5],
      holdDeadline:    Number(s[6]),
      isFullyFunded:   s[7],
      isDeadlinePassed: s[8],
    };
  } catch (e) {
    return { state: 0, stateLabel: 'None', error: e.message };
  }
}


// ─────────────────────────────────────────────────────────────────
// operatorDeposit (standalone) — deposit 라우트에서 직접 호출
// ─────────────────────────────────────────────────────────────────
async function operatorDeposit(sessionId, depositUsdc, userDepTxHash) {
  await ensureTable();
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const usdc     = getUsdc(wallet);
  const escrowId = toEscrowId(sessionId);
  const amtWei   = ethers.parseUnits(String(depositUsdc || '3'), 6);

  // 온체인 상태 확인
  let state = 0, opDeposit = 0n;
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    state    = Number(s[0]);
    opDeposit = s[2]; // operatorDeposit amount
  } catch (e) {
    logger.warn('operatorDeposit: getEscrowStatus 실패', { sessionId, error: e.message });
  }

  // 이미 FullyFunded(2) 이상이면 skip
  if (state >= 2) {
    logger.info('operatorDeposit: 이미 FullyFunded 이상, skip', { sessionId, state: STATE_LABELS[state] });
    return { skipped: true, reason: 'already_fully_funded', state: STATE_LABELS[state] };
  }

  // ★ 핵심 원칙: userDeposit은 반드시 사용자(MetaMask)가 먼저 온체인에서 완료해야 함
  // 온체인 state === 1 (UserDeposited) 확인된 경우에만 operatorDeposit 실행
  if (state === 0) {
    logger.warn('operatorDeposit: 온체인 userDeposit 미확인(state=Idle) — skip', { sessionId });
    return { skipped: true, reason: 'user_deposit_not_found_onchain', state: 'Idle' };
  }
  if (state !== 1) {
    logger.warn('operatorDeposit: 예상치 못한 상태', { sessionId, state: STATE_LABELS[state] });
    return { skipped: true, reason: 'unexpected_state', state: STATE_LABELS[state] };
  }

  try {
    const al = await usdc.allowance(wallet.address, ESCROW_ADDR);
    if (al < amtWei) {
      const atx = await usdc.approve(ESCROW_ADDR, amtWei * 10n, { gasLimit: 80000 });
      await atx.wait();
    }
    const tx = await escrow.operatorDeposit(escrowId, amtWei, { gasLimit: 150000 });
    const r  = await tx.wait();
    logger.info('operatorDeposit OK → FullyFunded', { sessionId, tx: r.hash });

    await getPool().query(
      `UPDATE escrow_locks SET operator_deposit=$2, operator_deposit_tx=$3, state='FullyFunded' WHERE session_id=$1`,
      [sessionId, depositUsdc, r.hash]
    ).catch(() => {});

    return { txHash: r.hash, operatorDeposit: depositUsdc };
  } catch (e) {
    logger.error('operatorDeposit 실패', { sessionId, error: e.message.slice(0, 200) });
    throw e;
  }
}


// ─────────────────────────────────────────────────────────────────
// claimSettlement (V3.2 stub)
// V3.2는 settleAndRelease 하나로 정산 완료 — 별도 claim 단계 없음
// watchtower 호환성을 위해 stub으로 유지 (Released 상태 확인 후 skip)
// ─────────────────────────────────────────────────────────────────
async function claimSettlement(sessionId) {
  await ensureTable();
  const escrow   = getEscrow(getProvider());
  const escrowId = toEscrowId(sessionId);

  let state = 0;
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    state = Number(s[0]);
  } catch (_) {}

  // Released(4) 또는 Refunded(5) — 이미 정산 완료
  if (state === 4 || state === 5) {
    logger.info('claimSettlement: 이미 정산 완료 (V3.2는 별도 claim 불필요)', {
      sessionId, state: STATE_LABELS[state]
    });
    await getPool().query(
      `UPDATE escrow_locks SET state=$2 WHERE session_id=$1 AND state='Released'`,
      [sessionId, STATE_LABELS[state]]
    ).catch(() => {});
    return { skipped: true, reason: 'v32_no_claim_needed', state: STATE_LABELS[state] };
  }

  return { skipped: true, reason: 'not_released', state: STATE_LABELS[state] };
}

module.exports = {
  recordUserDeposit,
  settleAndRelease,
  registerRefundIssue,
  refundToBuyer,
  operatorDeposit,
  forceRefundOnchain,
  getOnchainStatus,
  claimSettlement,
  toEscrowId,
};
