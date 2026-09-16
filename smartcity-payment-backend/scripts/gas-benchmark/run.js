'use strict';

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OUT = path.join(ROOT, 'results', 'gas-analysis');
const BACKEND = process.env.BENCHMARK_BACKEND_URL || 'https://payment-backend-production.up.railway.app';
const RPC = process.env.BASE_RPC_URL;
const ESCROW_ADDRESS = process.env.ESCROW_CONTRACT_ADDRESS;
const USDC_ADDRESS = process.env.USDC_CONTRACT_ADDRESS;
const rawOperatorKey = process.env.OPERATOR_PRIVATE_KEY;

const DEPOSIT = ethers.parseUnits('3', 6);
const BATCH_SIZE = 5;
const INITIAL_SAMPLES = 10;
const ADAPTIVE_SAMPLES = 30;
const MAX_LOG_BLOCK_RANGE = 10;
const CHECKPOINT = path.join(OUT, '.checkpoint.json');

const escrowAbi = [
  'function userDeposit(bytes32,address,uint256,uint256,bytes32)',
  'function getEscrowStatus(bytes32) view returns(uint8,uint256,uint256,uint256,address,address,uint256,bool,bool)',
  'function getSettlementClaim(bytes32) view returns(uint256,uint256,uint256,uint256,bool)',
  'function CLAIM_PERIOD() view returns(uint256)',
  'event OperatorDeposited(bytes32 indexed escrowId,address indexed operator,uint256 amount)',
  'event SettlementReserved(bytes32 indexed escrowId,address indexed operator,uint256 fare,address indexed user,uint256 userRefund,uint256 operatorRefund,uint256 claimableAfter)',
  'event SettlementClaimed(bytes32 indexed escrowId,address indexed operator,uint256 fare,address indexed user,uint256 userRefund,uint256 operatorRefund)',
  'event RefundIssueRegistered(bytes32 indexed escrowId,uint8 issueType,string description,bool penalizeOperator,uint256 registeredAt)',
  'event RefundedToBuyer(bytes32 indexed escrowId,address indexed user,uint256 amount,uint256 penalty)',
];
const usdcAbi = [
  'function balanceOf(address) view returns(uint256)',
  'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)',
  'function transfer(address,uint256) returns(bool)',
];

const rows = [];
const failures = [];
const setupTransactions = [];
let provider;
let operator;
let user;
let userAddress;
let escrow;
let usdcOperator;
let usdcUser;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function checkpoint() {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(CHECKPOINT, JSON.stringify({ rows, failures, setupTransactions }, null, 2));
}

function required(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function normalizeKey(value) {
  return value.startsWith('0x') ? value : `0x${value}`;
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(file, headers, values) {
  const body = [headers.join(','), ...values.map(row => headers.map(h => csvEscape(row[h])).join(','))].join('\n');
  fs.writeFileSync(path.join(OUT, file), `${body}\n`);
}

async function api(method, pathname, body) {
  const response = await fetch(`${BACKEND}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(`${method} ${pathname}: ${response.status} ${payload.error || JSON.stringify(payload.errors || payload)}`);
  }
  return payload.data;
}

async function recordReceipt({ scenario, runNumber, operation, contractFunction, sessionId, escrowId, txHash }) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`Receipt not found: ${txHash}`);
  let block;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    block = await provider.getBlock(receipt.blockNumber);
    if (block) break;
    if (attempt < 10) await sleep(1000);
  }
  if (!block) throw new Error(`Block not available after receipt: ${receipt.blockNumber}`);
  const gasPrice = receipt.gasPrice ?? 0n;
  rows.push({
    scenario,
    run_number: runNumber,
    operation,
    contract_function: contractFunction,
    session_id: sessionId,
    escrow_id: escrowId,
    tx_hash: receipt.hash,
    block_number: receipt.blockNumber,
    gas_used: receipt.gasUsed.toString(),
    effective_gas_price_wei: gasPrice.toString(),
    transaction_fee_wei: (receipt.gasUsed * gasPrice).toString(),
    success: Number(receipt.status) === 1,
    reverted: Number(receipt.status) !== 1,
    timestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
  });
  checkpoint();
  if (Number(receipt.status) !== 1) throw new Error(`Transaction reverted: ${txHash}`);
  return receipt;
}

function recordFailure({ scenario, runNumber, operation, sessionId = '', escrowId = '', error }) {
  const safeError = String(error?.message || error)
    .replace(/https?:\/\/[^\s"']+/g, '[redacted-url]')
    .slice(0, 1000);
  failures.push({
    scenario,
    run_number: runNumber,
    operation,
    session_id: sessionId,
    escrow_id: escrowId,
    error: safeError,
    timestamp: new Date().toISOString(),
  });
  fs.mkdirSync(OUT, { recursive: true });
  writeCsv('failures.csv', ['scenario', 'run_number', 'operation', 'session_id', 'escrow_id', 'error', 'timestamp'], failures);
  console.error(`[failure] ${scenario} run=${runNumber} operation=${operation} session=${sessionId || '-'}`);
  checkpoint();
}

async function sendSetup(label, send) {
  const tx = await send();
  const receipt = await tx.wait();
  setupTransactions.push({ label, txHash: receipt.hash, gasUsed: receipt.gasUsed.toString() });
  return receipt;
}

async function ensureUserFunding(requiredUsdc) {
  const minEth = ethers.parseEther('0.004');
  const eth = await provider.getBalance(userAddress);
  if (eth < minEth) {
    await sendSetup('Benchmark user ETH funding', () => operator.sendTransaction({
      to: userAddress,
      value: minEth - eth,
    }));
  }

  const required = ethers.parseUnits(requiredUsdc, 6);
  const balance = await usdcUser.balanceOf(userAddress);
  if (balance < required) {
    await sendSetup('Benchmark user USDC funding', () => usdcOperator.transfer(userAddress, required - balance));
  }

  const allowance = await usdcUser.allowance(userAddress, ESCROW_ADDRESS);
  if (allowance < ethers.parseUnits('1000', 6)) {
    await sendSetup('USDC approve reference (excluded)', () => usdcUser.approve(ESCROW_ADDRESS, ethers.MaxUint256));
  }
}

async function findEventTx(filter, fromBlock, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let cursor = fromBlock;
  while (Date.now() < deadline) {
    const latest = await provider.getBlockNumber();
    while (cursor <= latest) {
      const end = Math.min(cursor + MAX_LOG_BLOCK_RANGE - 1, latest);
      const logs = await escrow.queryFilter(filter, cursor, end);
      if (logs.length) return logs[0].transactionHash;
      cursor = end + 1;
    }
    await sleep(5000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitUntilUnix(timestamp, extraSeconds = 0) {
  const ms = (Number(timestamp) + extraSeconds) * 1000 - Date.now();
  if (ms > 0) await sleep(ms);
}

async function createFundedSession(scenario, runNumber, recordDeposits) {
  let session;
  const fromBlock = await provider.getBlockNumber();
  try {
    session = await api('POST', '/api/v1/sessions/start', {
      userAddress,
      serviceType: 'bicycle',
      depositUsdc: '3',
      meta: { benchmark: true, scenario, runNumber },
    });

    const depositTx = await escrow.connect(user).userDeposit(
      session.escrowId,
      operator.address,
      DEPOSIT,
      session.holdDeadline,
      session.channelId,
    );
    const depositReceipt = await depositTx.wait();
    if (recordDeposits) {
      await recordReceipt({
        scenario: 'normal', runNumber, operation: 'User Deposit', contractFunction: 'userDeposit',
        sessionId: session.sessionId, escrowId: session.escrowId, txHash: depositReceipt.hash,
      });
    }

    const depositBody = {
      channelId: session.channelId,
      userAddress,
      operatorAddress: operator.address,
      depositUsdc: '3',
      holdDeadline: session.holdDeadline,
      depositTxHash: depositReceipt.hash,
    };
    let depositResult;
    let depositError;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      try {
        depositResult = await api('POST', `/api/v1/sessions/${session.sessionId}/deposit`, depositBody);
        break;
      } catch (error) {
        depositError = error;
        if (attempt < 5) await sleep(1500);
      }
    }
    if (!depositResult) throw depositError;
    const operatorTxHash = depositResult?.operatorDeposit?.txHash || await findEventTx(
      escrow.filters.OperatorDeposited(session.escrowId), fromBlock, 30_000, 'OperatorDeposited');
    if (!operatorTxHash) throw new Error('Backend did not return operatorDeposit txHash');
    if (recordDeposits) {
      await recordReceipt({
        scenario: 'normal', runNumber, operation: 'Operator Deposit', contractFunction: 'operatorDeposit',
        sessionId: session.sessionId, escrowId: session.escrowId, txHash: operatorTxHash,
      });
    }
    return { ...session, fromBlock };
  } catch (error) {
    recordFailure({
      scenario, runNumber, operation: 'Session funding',
      sessionId: session?.sessionId, escrowId: session?.escrowId, error,
    });
    user.reset();
    return null;
  }
}

async function runNormalBatch(runNumbers, recordOperations) {
  console.log(`[normal] runs ${runNumbers[0]}-${runNumbers[runNumbers.length - 1]} start`);
  await ensureUserFunding(String(runNumbers.length * 3 + 1));
  const sessions = [];
  for (const runNumber of runNumbers) {
    const session = await createFundedSession('normal', runNumber,
      recordOperations.has('User Deposit') || recordOperations.has('Operator Deposit'));
    if (session) sessions.push({ ...session, runNumber });
  }
  if (!sessions.length) return;

  await waitUntilUnix(Math.max(...sessions.map(s => Number(s.holdDeadline))), 5);
  for (const session of sessions) {
    try {
      await api('POST', `/api/v1/sessions/${session.sessionId}/end`, {
        channelId: session.channelId,
        userAddress,
      });
    } catch (error) {
      recordFailure({ scenario: 'normal', runNumber: session.runNumber, operation: 'End session',
        sessionId: session.sessionId, escrowId: session.escrowId, error });
    }
  }

  for (const session of sessions) {
    try {
      const txHash = await findEventTx(
        escrow.filters.SettlementReserved(session.escrowId), session.fromBlock, 180_000, 'SettlementReserved');
      if (recordOperations.has('Settlement Reservation')) {
        await recordReceipt({
          scenario: 'normal', runNumber: session.runNumber, operation: 'Settlement Reservation',
          contractFunction: 'settleAndRelease', sessionId: session.sessionId,
          escrowId: session.escrowId, txHash,
        });
      }
      const claim = await escrow.getSettlementClaim(session.escrowId);
      session.claimableAfter = Number(claim[0]);
      session.claimSearchBlock = (await provider.getTransactionReceipt(txHash)).blockNumber;
    } catch (error) {
      recordFailure({ scenario: 'normal', runNumber: session.runNumber, operation: 'Settlement Reservation',
        sessionId: session.sessionId, escrowId: session.escrowId, error });
    }
  }

  const claimable = sessions.filter(s => s.claimableAfter);
  if (claimable.length) {
    await waitUntilUnix(Math.max(...claimable.map(s => s.claimableAfter)), 35);
  }
  for (const session of claimable) {
    try {
      const txHash = await findEventTx(
        escrow.filters.SettlementClaimed(session.escrowId), session.claimSearchBlock, 180_000, 'SettlementClaimed');
      if (recordOperations.has('Settlement Claim')) {
        await recordReceipt({
          scenario: 'normal', runNumber: session.runNumber, operation: 'Settlement Claim',
          contractFunction: 'claimSettlement', sessionId: session.sessionId,
          escrowId: session.escrowId, txHash,
        });
      }
    } catch (error) {
      recordFailure({ scenario: 'normal', runNumber: session.runNumber, operation: 'Settlement Claim',
        sessionId: session.sessionId, escrowId: session.escrowId, error });
    }
  }
  console.log(`[normal] runs ${runNumbers[0]}-${runNumbers[runNumbers.length - 1]} done`);
}

async function runRefundBatch(runNumbers, recordOperations) {
  console.log(`[refund] runs ${runNumbers[0]}-${runNumbers[runNumbers.length - 1]} start`);
  await ensureUserFunding(String(runNumbers.length * 3 + 1));
  const sessions = [];
  for (const runNumber of runNumbers) {
    const session = await createFundedSession('refund', runNumber, false);
    if (session) sessions.push({ ...session, runNumber });
  }

  for (const session of sessions) {
    try {
      const refundCase = await api('POST', '/api/v1/refunds', {
        userAddress,
        sessionId: session.sessionId,
        channelId: session.channelId,
        reason: 'unlock_failure',
        requestedUsdc: '3',
        evidence: [{ type: 'gas_benchmark', description: 'fixed-length-refund-case' }],
      });
      const decision = await api('POST', `/api/v1/refunds/${refundCase.id}/evaluate`, {});
      if (decision.decision === 'manual_required') {
        await api('POST', `/api/v1/refunds/${refundCase.id}/approve`, {
          approvedUsdc: '3', reviewerNotes: 'gas benchmark fixed approval',
        });
      }
      await api('POST', `/api/v1/refunds/${refundCase.id}/payout`, { sessionId: session.sessionId });

      const issueTx = await findEventTx(
        escrow.filters.RefundIssueRegistered(session.escrowId), session.fromBlock, 120_000, 'RefundIssueRegistered');
      const refundTx = await findEventTx(
        escrow.filters.RefundedToBuyer(session.escrowId), session.fromBlock, 120_000, 'RefundedToBuyer');
      if (recordOperations.has('Dispute Registration')) {
        await recordReceipt({
          scenario: 'refund', runNumber: session.runNumber, operation: 'Dispute Registration',
          contractFunction: 'registerRefundIssue', sessionId: session.sessionId,
          escrowId: session.escrowId, txHash: issueTx,
        });
      }
      if (recordOperations.has('Refund Execution')) {
        await recordReceipt({
          scenario: 'refund', runNumber: session.runNumber, operation: 'Refund Execution',
          contractFunction: 'refundToBuyer', sessionId: session.sessionId,
          escrowId: session.escrowId, txHash: refundTx,
        });
      }
    } catch (error) {
      recordFailure({ scenario: 'refund', runNumber: session.runNumber, operation: 'Refund flow',
        sessionId: session.sessionId, escrowId: session.escrowId, error });
    }
  }
  console.log(`[refund] runs ${runNumbers[0]}-${runNumbers[runNumbers.length - 1]} done`);
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = n > 1 ? sorted.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (n - 1) : 0;
  const stddev = Math.sqrt(variance);
  return { n, mean, median, stddev, min: sorted[0], max: sorted[n - 1], cv: mean ? stddev / mean * 100 : 0 };
}

function samplesFor(operation) {
  return rows.filter(row => row.operation === operation && row.success).map(row => Number(row.gas_used));
}

function aggregateSamples(left, right) {
  const pairs = new Map();
  for (const row of rows.filter(r => [left, right].includes(r.operation) && r.success)) {
    const key = `${row.scenario}:${row.run_number}`;
    if (!pairs.has(key)) pairs.set(key, {});
    pairs.get(key)[row.operation] = Number(row.gas_used);
  }
  return [...pairs.values()].filter(pair => pair[left] !== undefined && pair[right] !== undefined)
    .map(pair => pair[left] + pair[right]);
}

function meanEffectiveGasPriceGwei(operations) {
  const selected = rows.filter(row => operations.includes(row.operation) && row.success);
  if (!selected.length) return null;
  const totalGas = selected.reduce((sum, row) => sum + Number(row.gas_used), 0);
  const totalFeeWei = selected.reduce((sum, row) => sum + Number(row.transaction_fee_wei), 0);
  return totalFeeWei / totalGas / 1e9;
}

async function executeSamples() {
  const normalOps = new Set(['User Deposit', 'Operator Deposit', 'Settlement Reservation', 'Settlement Claim']);
  const refundOps = new Set(['Dispute Registration', 'Refund Execution']);
  let nextNormalRun = Math.max(0, ...rows.filter(row => row.scenario === 'normal').map(row => Number(row.run_number))) + 1;
  while ([...normalOps].some(op => samplesFor(op).length < INITIAL_SAMPLES)) {
    const targets = new Set([...normalOps].filter(op => samplesFor(op).length < INITIAL_SAMPLES));
    const runNumbers = Array.from({ length: BATCH_SIZE }, (_, i) => nextNormalRun + i);
    await runNormalBatch(runNumbers, targets);
    nextNormalRun += BATCH_SIZE;
    if (nextNormalRun > 60) throw new Error('Initial normal sampling safety limit reached');
  }
  let nextRefundRun = Math.max(0, ...rows.filter(row => row.scenario === 'refund').map(row => Number(row.run_number))) + 1;
  while ([...refundOps].some(op => samplesFor(op).length < INITIAL_SAMPLES)) {
    const targets = new Set([...refundOps].filter(op => samplesFor(op).length < INITIAL_SAMPLES));
    const runNumbers = Array.from({ length: BATCH_SIZE }, (_, i) => nextRefundRun + i);
    await runRefundBatch(runNumbers, targets);
    nextRefundRun += BATCH_SIZE;
    if (nextRefundRun > 60) throw new Error('Initial refund sampling safety limit reached');
  }

  const allOps = [...normalOps, ...refundOps];
  let nextRun = Math.max(nextNormalRun, nextRefundRun);
  while (allOps.some(op => samplesFor(op).length < INITIAL_SAMPLES)) {
    const normalTargets = new Set(allOps.filter(op => normalOps.has(op) && samplesFor(op).length < INITIAL_SAMPLES));
    const refundTargets = new Set(allOps.filter(op => refundOps.has(op) && samplesFor(op).length < INITIAL_SAMPLES));
    const runNumbers = Array.from({ length: BATCH_SIZE }, (_, i) => nextRun + i);
    if (normalTargets.size) await runNormalBatch(runNumbers, normalTargets);
    if (refundTargets.size) await runRefundBatch(runNumbers, refundTargets);
    nextRun += BATCH_SIZE;
    if (nextRun > 60) throw new Error('Initial sampling safety limit reached');
  }

  const highCv = allOps.filter(op => samplesFor(op).length >= INITIAL_SAMPLES && stats(samplesFor(op).slice(0, INITIAL_SAMPLES)).cv >= 5);
  if (!highCv.length) return highCv;

  while (highCv.some(op => samplesFor(op).length < ADAPTIVE_SAMPLES)) {
    const normalTargets = new Set(highCv.filter(op => normalOps.has(op) && samplesFor(op).length < ADAPTIVE_SAMPLES));
    const refundTargets = new Set(highCv.filter(op => refundOps.has(op) && samplesFor(op).length < ADAPTIVE_SAMPLES));
    const runNumbers = Array.from({ length: BATCH_SIZE }, (_, i) => nextRun + i);
    if (normalTargets.size) await runNormalBatch(runNumbers, normalTargets);
    if (refundTargets.size) await runRefundBatch(runNumbers, refundTargets);
    nextRun += BATCH_SIZE;
    if (nextRun > 60) throw new Error('Adaptive sampling safety limit reached');
  }
  return highCv;
}

function buildSummary() {
  const definitions = [
    ['User Deposit', 'userDeposit', samplesFor('User Deposit'), ['User Deposit']],
    ['Operator Deposit', 'operatorDeposit', samplesFor('Operator Deposit'), ['Operator Deposit']],
    ['Settlement Reservation', 'settleAndRelease', samplesFor('Settlement Reservation'), ['Settlement Reservation']],
    ['Settlement Claim', 'claimSettlement', samplesFor('Settlement Claim'), ['Settlement Claim']],
    ['Dispute Registration', 'registerRefundIssue', samplesFor('Dispute Registration'), ['Dispute Registration']],
    ['Refund Execution', 'refundToBuyer', samplesFor('Refund Execution'), ['Refund Execution']],
    ['Deposit Total', 'userDeposit + operatorDeposit', aggregateSamples('User Deposit', 'Operator Deposit'), ['User Deposit', 'Operator Deposit']],
    ['Settlement Total', 'settleAndRelease + claimSettlement', aggregateSamples('Settlement Reservation', 'Settlement Claim'), ['Settlement Reservation', 'Settlement Claim']],
  ];
  return definitions.map(([operation, fn, values, priceOperations]) => {
    if (!values.length) return { operation, contract_function: fn, sample_count: 0 };
    const s = stats(values);
    return {
      operation,
      contract_function: fn,
      sample_count: s.n,
      mean_gas: s.mean.toFixed(2),
      median_gas: s.median.toFixed(2),
      stddev_gas: s.stddev.toFixed(2),
      min_gas: s.min,
      max_gas: s.max,
      cv_percent: s.cv.toFixed(4),
      mean_effective_gas_price_gwei_per_gas: meanEffectiveGasPriceGwei(priceOperations).toFixed(6),
    };
  });
}

async function verifyFinalStates() {
  const problems = [];
  for (const row of rows.filter(r => ['Settlement Claim', 'Refund Execution'].includes(r.operation))) {
    const status = await escrow.getEscrowStatus(row.escrow_id);
    const state = Number(status[0]);
    if (row.operation === 'Settlement Claim') {
      const claim = await escrow.getSettlementClaim(row.escrow_id);
      if (state !== 4 || !claim[4]) problems.push(`${row.session_id}: normal settlement not claimed`);
    } else if (state !== 5) {
      problems.push(`${row.session_id}: refund not finalized`);
    }
  }
  return problems;
}

function writeResults(summary, highCv, verificationProblems, environment) {
  fs.mkdirSync(OUT, { recursive: true });
  writeCsv('raw_transactions.csv', [
    'scenario', 'run_number', 'operation', 'contract_function', 'session_id', 'escrow_id',
    'tx_hash', 'block_number', 'gas_used', 'effective_gas_price_wei', 'transaction_fee_wei',
    'success', 'reverted', 'timestamp',
  ], rows);
  writeCsv('summary.csv', [
    'operation', 'contract_function', 'sample_count', 'mean_gas', 'median_gas',
    'stddev_gas', 'min_gas', 'max_gas', 'cv_percent',
    'mean_effective_gas_price_gwei_per_gas',
  ], summary);
  writeCsv('failures.csv', [
    'scenario', 'run_number', 'operation', 'session_id', 'escrow_id', 'error', 'timestamp',
  ], failures);

  const measured = summary.slice(0, 6);
  const highest = [...measured].filter(r => r.sample_count).sort((a, b) => Number(b.mean_gas) - Number(a.mean_gas))[0];
  const md = `# SmartCityEscrow Gas Benchmark\n\n` +
    `## Environment\n\n` +
    `- Branch / commit: go-sdk / ${environment.commit}\n` +
    `- Network: Base Sepolia (chainId 84532)\n` +
    `- SmartCityEscrow: \`${ESCROW_ADDRESS}\`\n` +
    `- USDC: \`${USDC_ADDRESS}\`\n` +
    `- Benchmark user: \`${userAddress}\`\n` +
    `- User/operator deposit: 3 USDC each\n` +
    `- Service: bicycle\n` +
    `- CLAIM_PERIOD: ${environment.claimPeriod} seconds\n` +
    `- Standard deviation: sample standard deviation (n-1)\n\n` +
    `## Results\n\n` +
    `| Operation | N | Mean gas (gas units) | Median | Stddev | Min | Max | CV | Avg effective gas price (gwei/gas) |\n` +
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|\n` +
    summary.map(r => `| ${r.operation} | ${r.sample_count} | ${r.mean_gas || ''} | ${r.median_gas || ''} | ${r.stddev_gas || ''} | ${r.min_gas || ''} | ${r.max_gas || ''} | ${r.cv_percent || ''}% | ${r.mean_effective_gas_price_gwei_per_gas || ''} |`).join('\n') +
    `\n\n- Successful measured transactions: ${rows.filter(r => r.success).length}\n` +
    `- Failures: ${failures.length}\n` +
    `- Operations extended to 30 samples because CV >= 5%: ${highCv.length ? highCv.join(', ') : 'none'}\n` +
    `- Highest mean-gas operation: ${highest ? `${highest.operation} (${highest.mean_gas})` : 'unavailable'}\n` +
    `- Final-state verification problems: ${verificationProblems.length ? verificationProblems.join('; ') : 'none'}\n\n` +
    `## Method and interpretation\n\n` +
    `Each operation used ten successful Base Sepolia receipts from fresh escrow and Perun channel identifiers. Failed transactions are excluded from statistics and recorded separately. Log queries were split into ranges of at most ten blocks to remain compatible with the RPC provider. Every normal-flow sample used the Backend to Go-Perun finalization path and the deployed contract verified the encoded Params, final State, two native participant signatures, and PaymentData appData before reserving settlement. Final verification confirmed settlementClaimed for normal flows and Refunded for refund flows.\n\n` +
    `These values measure the additional on-chain execution cost of the SmartCityEscrow design. They do not measure off-chain Go-Perun state update throughput. The average effective gas price is receipt-weighted and reported in gwei per gas; execution fee equals gasUsed multiplied by effective gas price. Gas price and transaction fees vary with network conditions, so gasUsed remains the primary comparison value. settleAndRelease includes ABI decoding, native signature verification, appData binding checks, and settlement reservation.\n\n` +
    `## Setup transactions excluded from statistics\n\n` +
    setupTransactions.map(tx => `- ${tx.label}: ${tx.txHash} (gas ${tx.gasUsed})`).join('\n') + `\n`;
  fs.writeFileSync(path.join(OUT, 'gas-analysis.md'), md);
}

async function main() {
  required('BASE_RPC_URL', RPC);
  required('ESCROW_CONTRACT_ADDRESS', ESCROW_ADDRESS);
  required('USDC_CONTRACT_ADDRESS', USDC_ADDRESS);
  required('OPERATOR_PRIVATE_KEY', rawOperatorKey);

  if (fs.existsSync(CHECKPOINT)) {
    const saved = JSON.parse(fs.readFileSync(CHECKPOINT, 'utf8'));
    rows.push(...(saved.rows || []));
    failures.push(...(saved.failures || []));
    setupTransactions.push(...(saved.setupTransactions || []));
    console.log(`[resume] ${rows.length} receipts loaded from checkpoint`);
  }

  provider = new ethers.JsonRpcProvider(RPC);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 84532) throw new Error(`Refusing non-Base-Sepolia chain ${network.chainId}`);
  operator = new ethers.Wallet(normalizeKey(rawOperatorKey), provider);
  const seed = ethers.keccak256(ethers.concat([
    ethers.getBytes(normalizeKey(rawOperatorKey)),
    ethers.toUtf8Bytes('smartcity-gas-benchmark-user-v1'),
  ]));
  const userWallet = new ethers.Wallet(seed, provider);
  userAddress = userWallet.address;
  user = new ethers.NonceManager(userWallet);
  escrow = new ethers.Contract(ESCROW_ADDRESS, escrowAbi, operator);
  usdcOperator = new ethers.Contract(USDC_ADDRESS, usdcAbi, operator);
  usdcUser = new ethers.Contract(USDC_ADDRESS, usdcAbi, user);
  const boundUsdc = await new ethers.Contract(ESCROW_ADDRESS, ['function usdc() view returns(address)'], provider).usdc();
  if (boundUsdc.toLowerCase() !== USDC_ADDRESS.toLowerCase()) throw new Error('Escrow/USDC configuration mismatch');
  if (operator.address.toLowerCase() !== String(process.env.OPERATOR_ADDRESS).toLowerCase()) throw new Error('Operator key/address mismatch');

  const highCv = await executeSamples();
  const summary = buildSummary();
  const incomplete = summary.slice(0, 6).filter(row => row.sample_count < INITIAL_SAMPLES);
  if (incomplete.length) {
    throw new Error(`Insufficient successful samples: ${incomplete.map(r => `${r.operation}=${r.sample_count}`).join(', ')}`);
  }
  const verificationProblems = await verifyFinalStates();
  if (verificationProblems.length) throw new Error(verificationProblems.join('; '));
  writeResults(summary, highCv, verificationProblems, {
    commit: process.env.BENCHMARK_COMMIT || '16721301',
    claimPeriod: Number(await escrow.CLAIM_PERIOD()),
  });
  if (fs.existsSync(CHECKPOINT)) fs.unlinkSync(CHECKPOINT);
  console.log(JSON.stringify({ output: OUT, summary, failures: failures.length }, null, 2));
}

main().catch(error => {
  fs.mkdirSync(OUT, { recursive: true });
  recordFailure({ scenario: 'benchmark', runNumber: '', operation: 'Fatal', error });
  writeCsv('failures.csv', ['scenario', 'run_number', 'operation', 'session_id', 'escrow_id', 'error', 'timestamp'], failures);
  console.error(error.stack || error.message);
  process.exit(1);
});
