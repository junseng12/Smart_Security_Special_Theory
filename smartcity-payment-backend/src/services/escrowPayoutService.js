/**
 * escrowPayoutService.js — SmartCityEscrow V3.2
 *
 * 컨트랙트: 0xa2642876a2Aa9F19D22a6e69379bbcA10556977f (Base Sepolia)
 * 상태머신: None(0) → UserDeposited(1) → FullyFunded(2) → RefundIssue(3) → Released(4) → Refunded(5)
 *
 * 주요 함수:
 *   userDeposit(escrowId, operator, amount, holdDeadline, channelId)
 *   operatorDeposit(escrowId, amount)
 *   settleAndRelease(escrowId, paramsABI, stateABI, signatures)
 *   registerRefundIssue(escrowId, issueType, description, penalizeOperator)
 *   refundToBuyer(escrowId, refundFare)
 *   forceRefund(escrowId)                   ← 긴급 환불
 *   getEscrowStatus(escrowId) →
 *     (state, userDeposit, operatorDeposit, fareAmount,
 *      user, operator, holdDeadline, isFullyFunded, isDeadlinePassed)
 */

const { ethers } = require('ethers');
const logger     = require('../utils/logger');
const chainTx    = require('./chainTransactionTracker');
const escrowLocks = require('./escrowLockRepository');

const ESCROW_ADDR = process.env.ESCROW_CONTRACT_ADDRESS;
const USDC_ADDR   = process.env.USDC_CONTRACT_ADDRESS   || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const BASE_RPC    = process.env.BASE_RPC_URL             || 'https://sepolia.base.org';

// V3.2 ABI — 온체인 검증 완료
const ESCROW_ABI = [
  'event UserDeposited(bytes32 indexed escrowId, address indexed user, address indexed operator, uint256 amount, uint256 holdDeadline)',
  'function userDeposit(bytes32 escrowId, address operator, uint256 amount, uint256 holdDeadline, bytes32 channelId) external',
  'function operatorDeposit(bytes32 escrowId, uint256 amount) external',
  'function settleAndRelease(bytes32 escrowId, bytes paramsABI, bytes stateABI, bytes[] signatures) external',
  'function registerRefundIssue(bytes32 escrowId, uint8 issueType, string calldata description, bool penalizeOperator) external',
  // 현재 0xa264... 배포본은 사용자 예치금 전액 환불형 1-argument ABI이다.
  'function refundToBuyer(bytes32 escrowId, uint256 refundFare) external',
  'function verifiedFare(bytes32 escrowId, bytes paramsABI, bytes stateABI, bytes[] signatures) view returns (uint256)',
  'function getSettlementClaim(bytes32 escrowId) view returns (uint256 claimableAfter,uint256 fareClaimed,uint256 userRefundClaimed,uint256 operatorRefundClaimed,bool settlementClaimed)',
  'function claimSettlement(bytes32 escrowId)',
  'function perunChannelIDs(bytes32 escrowId) view returns (bytes32)',
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

let operatorTxTail = Promise.resolve();

function runOperatorTransaction(label, task) {
  const queuedAt = Date.now();
  const run = operatorTxTail
    .catch(() => {})
    .then(async () => {
      logger.info('Operator transaction started', {
        label,
        queuedMs: Date.now() - queuedAt,
      });
      return task();
    });

  operatorTxTail = run.catch(() => {});
  return run;
}

async function executeTrackedFinalTx({ sessionId, action, send }) {
  const tracking = await chainTx.queueTransaction({ sessionId, action });
  try {
    return await runOperatorTransaction(`${action}:${sessionId}`, async () => {
      const tx = await send();
      await chainTx.markSubmitted(tracking.id, tx.hash);
      const receipt = await tx.wait();
      const verification = await chainTx.confirmTransaction(tracking.id, receipt);
      if (!verification.confirmed) {
        throw new Error(`On-chain ${action} verification failed: ${verification.reason}`);
      }
      return { receipt, verification };
    });
  } catch (err) {
    const reverted = err?.code === 'CALL_EXCEPTION' || Number(err?.receipt?.status) === 0;
    await chainTx.markProblem(
      tracking.id,
      reverted ? 'REVERTED' : 'NEEDS_REVIEW',
      err.message
    ).catch(() => {});
    throw err;
  }
}

async function verifyUserDepositTransaction({
  sessionId,
  userAddress,
  operatorAddress,
  depositUsdc,
  holdDeadline,
  depositTxHash,
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(depositTxHash || '')) {
    throw new Error('Invalid user deposit transaction hash');
  }

  const provider = getProvider();
  const receipt = await provider.waitForTransaction(depositTxHash, 1, 120000);
  if (!receipt) throw new Error('User deposit transaction confirmation timed out');
  if (Number(receipt.status) !== 1) throw new Error('User deposit transaction reverted');

  const expectedEscrowId = toEscrowId(sessionId).toLowerCase();
  const expectedUser = ethers.getAddress(userAddress);
  const expectedOperator = ethers.getAddress(operatorAddress);
  const expectedAmount = ethers.parseUnits(String(depositUsdc || '3'), 6);
  const escrowInterface = new ethers.Interface(ESCROW_ABI);

  let depositEvent = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== ESCROW_ADDR.toLowerCase()) continue;
    try {
      const parsed = escrowInterface.parseLog(log);
      if (parsed?.name !== 'UserDeposited') continue;
      if (String(parsed.args.escrowId).toLowerCase() !== expectedEscrowId) continue;
      depositEvent = { parsed, log };
      break;
    } catch (_) {
      // Other escrow events in the same receipt are intentionally ignored.
    }
  }

  if (!depositEvent) {
    throw new Error('UserDeposited event not found for this session');
  }

  const { parsed, log } = depositEvent;
  if (ethers.getAddress(parsed.args.user) !== expectedUser) {
    throw new Error('UserDeposited event user does not match the connected wallet');
  }
  if (ethers.getAddress(parsed.args.operator) !== expectedOperator) {
    throw new Error('UserDeposited event operator does not match the configured operator');
  }
  if (parsed.args.amount !== expectedAmount) {
    throw new Error('UserDeposited event amount does not match the requested deposit');
  }
  if (holdDeadline && Number(parsed.args.holdDeadline) !== Number(holdDeadline)) {
    throw new Error('UserDeposited event hold deadline does not match the session');
  }

  const status = await getEscrow(provider).getEscrowStatus(expectedEscrowId);
  const state = Number(status[0]);
  if (state < 1 || state > 5) {
    throw new Error(`Escrow did not record the user deposit (state=${state})`);
  }
  if (ethers.getAddress(status[4]) !== expectedUser) {
    throw new Error('On-chain escrow user does not match the UserDeposited event');
  }
  // Released/Refunded escrows intentionally zero their deposit balances.
  if (state < 4 && status[1] !== expectedAmount) {
    throw new Error('On-chain escrow amount does not match the UserDeposited event');
  }

  logger.info('User deposit event verified', {
    sessionId,
    depositTxHash,
    transactionTo: receipt.to,
    logIndex: log.index,
    state: STATE_LABELS[state],
  });

  return {
    txHash: depositTxHash,
    blockNumber: receipt.blockNumber,
    transactionTo: receipt.to,
    logIndex: log.index,
    escrowId: expectedEscrowId,
    user: expectedUser,
    operator: expectedOperator,
    amountUsdc: ethers.formatUnits(expectedAmount, 6),
    state: STATE_LABELS[state],
  };
}

// ─────────────────────────────────────────────────────────────────
// 1. recordUserDeposit
//    프론트에서 MetaMask로 userDeposit 온체인 TX 완료 후 호출
//    → Operator도 바로 operatorDeposit 실행 (FullyFunded 전환)
// ─────────────────────────────────────────────────────────────────
async function recordUserDeposit({ sessionId, channelId, userAddress, operatorAddress, depositUsdc, holdDeadline, depositTxHash }) {
  const escrowId = toEscrowId(sessionId);
  const escrow   = getEscrow(getProvider());
  const deadline = holdDeadline || (Math.floor(Date.now() / 1000) + HOLD_DEADLINE_SEC);
  const operator = operatorAddress || process.env.OPERATOR_ADDRESS;

  // 온체인 상태 확인
  let onchainState = 0;
  let onchainOperatorDeposit = '0';
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    onchainState = Number(s[0]);
    onchainOperatorDeposit = ethers.formatUnits(s[2], 6);
    logger.info('recordUserDeposit: 온체인 상태 확인', {
      sessionId, state: STATE_LABELS[onchainState], isFullyFunded: s[7]
    });
  } catch (e) {
    throw new Error(`Escrow state lookup failed after user deposit: ${e.message}`);
  }

  if (onchainState < 1) {
    throw new Error('Escrow is still in None state after the verified user deposit');
  }

  // operatorDeposit is deliberately performed only by operatorDeposit().
  const finalStateLabel = STATE_LABELS[onchainState] || 'None';

  await escrowLocks.upsertUserDeposit(getPool(), {
    sessionId,
    escrowId,
    channelId,
    userAddress,
    operatorAddress: operator,
    userDeposit: depositUsdc || '3',
    operatorDeposit: onchainOperatorDeposit,
    holdDeadline: deadline,
    userDepositTx: depositTxHash,
    state: finalStateLabel,
  });

  return {
    escrowId, sessionId, depositUsdc,
    holdDeadline: new Date(deadline * 1000).toISOString(),
    userDepTx: depositTxHash, opDepTx: null, state: finalStateLabel,
  };
}

// ─────────────────────────────────────────────────────────────────
// 2. settleAndRelease
//    세션 종료 시 호출 — holdDeadline 경과 후 settleAndRelease 실행
//    서버 DB의 serviceStartedAt 기준으로 요금 재계산 (프론트 값 무시)
// ─────────────────────────────────────────────────────────────────
const settlementTasks = new Map();

function validateProof(proof) {
  if (!proof || !ethers.isHexString(proof.paramsABI) || !ethers.isHexString(proof.stateABI)
      || proof.paramsABI.length <= 2 || proof.stateABI.length <= 2
      || proof.signatures?.length !== 2 || proof.signatures.some(s => !ethers.isHexString(s,65))) {
    throw new Error('Native Perun proof required; arbitrary fare settlement is disabled');
  }
}

async function settleAndReleaseInternal({sessionId,proof}) {
  if (!proof) {
    const {rows} = await getPool().query('SELECT perun_proof FROM escrow_locks WHERE session_id=$1',[sessionId]);
    proof = rows[0]?.perun_proof;
  }
  validateProof(proof);
  const escrow = getEscrow(getWallet());
  const escrowId = toEscrowId(sessionId);
  const status = await escrow.getEscrowStatus(escrowId);
  const state = Number(status[0]);
  if (state === 4) return claimSettlement(sessionId);
  if (state === 5) return {confirmed:true,state:'Refunded',skipped:true};
  if (state !== 2) throw new Error('State-bound settlement requires FullyFunded escrow');
  const fare = await escrow.verifiedFare(escrowId,proof.paramsABI,proof.stateABI,proof.signatures);
  const fareUsdc = ethers.formatUnits(fare,6);
  const refundUsdc = ethers.formatUnits(status[1]-fare,6);
  // Persist proof before deferral/submission so the main recovery scheduler can retry after restart.
  await getPool().query(`UPDATE escrow_locks SET perun_proof=$2, fare_amount=$3, state='PendingSettle' WHERE session_id=$1`,
    [sessionId,JSON.stringify(proof),fareUsdc]);
  if (!status[8]) return {deferred:true,confirmed:false,reason:'pending_deadline',fareUsdc,refundUsdc};
  const {receipt} = await executeTrackedFinalTx({sessionId,action:'SETTLE',
    send:() => escrow.settleAndRelease(escrowId,proof.paramsABI,proof.stateABI,proof.signatures)});
  const claim = await escrow.getSettlementClaim(escrowId);
  await getPool().query(`UPDATE escrow_locks SET state='Released',claimable_after=to_timestamp($2) WHERE session_id=$1`,[sessionId,Number(claim[0])]);
  return {txHash:receipt.hash,deferred:true,confirmed:false,reserved:true,state:'Released',fareUsdc,refundUsdc,claimableAfter:Number(claim[0])};
}

async function registerRefundIssue(sessionId, caseId, issueType, description, penalizeOperator = false) {
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const escrowId = toEscrowId(sessionId);
  const num      = ISSUE_TYPE_MAP[issueType] ?? 5;
  const desc     = `${caseId}|${description}`.slice(0, 200);

  const r = await runOperatorTransaction(`REGISTER_REFUND:${sessionId}`, async () => {
    const tx = await escrow.registerRefundIssue(escrowId, num, desc, penalizeOperator, { gasLimit: 200000 });
    return tx.wait();
  });

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
async function refundToBuyer(sessionId, caseId) {
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const escrowId = toEscrowId(sessionId);

  let state = null;
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    state = Number(s[0]);
    logger.info('refundToBuyer: 온체인 상태', { sessionId, state: STATE_LABELS[state] });
  } catch (e) {
    logger.warn('getEscrowStatus 실패', { sessionId, error: e.message });
    throw new Error(`Escrow state lookup failed: ${e.message}`);
  }

  if (state === 0) {
    await getPool().query(
      `UPDATE escrow_locks SET state='SettleFailed', last_error='no_onchain_escrow', case_id=$2 WHERE session_id=$1`,
      [sessionId, caseId]
    ).catch(() => {});
    return { skipped: true, confirmed: false, reason: 'no_onchain_escrow' };
  }

  if (state === 5) {
    await chainTx.syncFinalState(sessionId, STATE_LABELS[state]);
    return {
      skipped: true,
      confirmed: true,
      reason: 'already_refunded',
      state: STATE_LABELS[state],
    };
  }



  // 현재 배포본은 UserDeposited/FullyFunded 모두 RefundIssue 등록 후 즉시 전액 환불 가능하다.
  if (state === 1 || state === 2 || state === 4) {
    try {
      await runOperatorTransaction(`REGISTER_REFUND:${sessionId}`, async () => {
        const rt = await escrow.registerRefundIssue(
          escrowId, 5, `${caseId}|full_refund`, false, { gasLimit: 200000 }
        );
        return rt.wait();
      });
      logger.info('자동 registerRefundIssue OK', { sessionId });
    } catch (e) {
      logger.error('자동 registerRefundIssue 실패', { sessionId, error: e.message });
      throw e;
    }
  }

  // RefundIssue(3): pass zero fare for a full user refund.
  const { receipt: r } = await executeTrackedFinalTx({
    sessionId,
    action: 'REFUND',
    send: () => escrow.refundToBuyer(escrowId, 0, { gasLimit: 200000 }),
  });

  await getPool().query(
    `UPDATE escrow_locks SET case_id=$2 WHERE session_id=$1`,
    [sessionId, caseId]
  ).catch(() => {});

  logger.info('refundToBuyer OK', { sessionId, tx: r.hash });
  return { txHash: r.hash, confirmed: true, state: 'Refunded', mode: 'full_refund_to_buyer' };
}

// ─────────────────────────────────────────────────────────────────
// 5. forceRefundOnchain — 긴급 환불 (관리자용)
// ─────────────────────────────────────────────────────────────────
async function forceRefundOnchain(sessionId) {
  const wallet   = getWallet();
  const escrow   = getEscrow(wallet);
  const escrowId = toEscrowId(sessionId);

  let state = null;
  try {
    const s = await escrow.getEscrowStatus(escrowId);
    state = Number(s[0]);
  } catch (e) {
    throw new Error(`Escrow state lookup failed: ${e.message}`);
  }

  if (state === 0) return { skipped: true, reason: 'no_onchain_escrow' };
  if (state === 4 || state === 5) {
    await chainTx.syncFinalState(sessionId, STATE_LABELS[state]);
    return {
      skipped: true,
      confirmed: true,
      reason: 'already_settled',
      state: STATE_LABELS[state],
    };
  }

  const { receipt: r } = await executeTrackedFinalTx({
    sessionId,
    action: 'REFUND',
    send: () => escrow.forceRefund(escrowId, { gasLimit: 200000 }),
  });

  logger.info('forceRefund OK', { sessionId, tx: r.hash });
  return { txHash: r.hash, confirmed: true, state: 'Refunded', mode: 'force_refund' };
}

async function settleAndRelease(params) {
  const existing = settlementTasks.get(params.sessionId);
  if (existing) return existing;

  const task = settleAndReleaseInternal(params)
    .finally(() => settlementTasks.delete(params.sessionId));
  settlementTasks.set(params.sessionId, task);
  return task;
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
  return runOperatorTransaction(
    `OPERATOR_DEPOSIT:${sessionId}`,
    () => operatorDepositUnlocked(sessionId, depositUsdc, userDepTxHash)
  );
}

async function operatorDepositUnlocked(sessionId, depositUsdc, userDepTxHash) {
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
    await getPool().query(
      `UPDATE escrow_locks
       SET operator_deposit=$2, state=$3, last_error=NULL
       WHERE session_id=$1`,
      [sessionId, ethers.formatUnits(opDeposit, 6), STATE_LABELS[state]]
    );
    logger.info('operatorDeposit: 이미 FullyFunded 이상, skip', { sessionId, state: STATE_LABELS[state] });
    return { skipped: true, reason: 'already_fully_funded', state: STATE_LABELS[state] };
  }

  // 온체인 상태가 None(0)이면 DB 상태 확인 (테스트/mock TX 환경 대응)
  if (state === 0) {
    const dbRow = await getPool().query(
      `SELECT state FROM escrow_locks WHERE session_id=$1`, [sessionId]
    ).catch(() => ({ rows: [] }));
    const dbState = dbRow.rows[0]?.state;
    if (!dbState || !['UserDeposited','FullyFunded'].includes(dbState)) {
      logger.warn('operatorDeposit: 온체인 None + DB 미등록, skip', { sessionId, dbState });
      return { skipped: true, reason: 'no_user_deposit', state: 'None' };
    }
    logger.info('operatorDeposit: 온체인 None이나 DB UserDeposited — 실행 진행', { sessionId, dbState });
  } else if (state !== 1) {
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
    );

    return { txHash: r.hash, operatorDeposit: depositUsdc };
  } catch (e) {
    logger.error('operatorDeposit 실패', { sessionId, error: e.message.slice(0, 200) });
    throw e;
  }
}


// ─────────────────────────────────────────────────────────────────
// claimSettlement distributes the reserved fare/refund after the dispute window.
// ─────────────────────────────────────────────────────────────────
async function claimSettlement(sessionId) {
  const escrow = getEscrow(getWallet());
  const escrowId = toEscrowId(sessionId);
  const status = await escrow.getEscrowStatus(escrowId);
  if (Number(status[0]) !== 4) return {skipped:true,confirmed:false,reason:'not_released'};
  const claim = await escrow.getSettlementClaim(escrowId);
  const fareUsdc = ethers.formatUnits(status[3],6);
  const refundUsdc = ethers.formatUnits(status[1]-status[3],6);
  if (claim[4]) {
    await chainTx.syncFinalState(sessionId,'Released');
    return {confirmed:true,skipped:true,state:'Released',fareUsdc,refundUsdc};
  }
  const block = await escrow.runner.provider.getBlock('latest');
  if (BigInt(block.timestamp) < claim[0]) return {deferred:true,confirmed:false,reason:'dispute_window',fareUsdc,refundUsdc};
  const {receipt} = await executeTrackedFinalTx({sessionId,action:'CLAIM',send:() => escrow.claimSettlement(escrowId)});
  return {confirmed:true,txHash:receipt.hash,state:'Released',fareUsdc,refundUsdc};
}

module.exports = {
  validateProof,
  verifyUserDepositTransaction,
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
