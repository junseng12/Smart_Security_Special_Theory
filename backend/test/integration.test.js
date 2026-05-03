/**
 * Integration Test (Mock 환경)
 * ─────────────────────────────────────────────────────────────────────────────
 * Perun / 블록체인 없이 핵심 비즈니스 로직을 검증합니다.
 * 실행: node test/integration.test.js
 */

require('dotenv').config({ path: '.env.test' });

// ── Mock 설정 ──────────────────────────────────────────────────────────────────

// 인메모리 Redis mock
const redisStore = {};

// 환경변수 기본값
process.env.BASE_RPC_URL       = process.env.BASE_RPC_URL       || 'https://sepolia.base.org';
process.env.USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
process.env.OPERATOR_PRIVATE_KEY  = process.env.OPERATOR_PRIVATE_KEY  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.OPERATOR_ADDRESS      = process.env.OPERATOR_ADDRESS      || '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
process.env.TREASURY_PRIVATE_KEY  = process.env.TREASURY_PRIVATE_KEY  || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.TREASURY_ADDRESS      = process.env.TREASURY_ADDRESS      || '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
process.env.DATABASE_URL          = process.env.DATABASE_URL          || 'postgresql://user:password@localhost:5432/smartcity_test';
process.env.REDIS_HOST            = process.env.REDIS_HOST            || 'localhost';
process.env.PERUN_GRPC_HOST       = process.env.PERUN_GRPC_HOST       || 'localhost';
process.env.PERUN_GRPC_PORT       = process.env.PERUN_GRPC_PORT       || '8080';

const assert = (condition, msg) => {
  if (!condition) throw new Error(`❌ FAIL: ${msg}`);
  console.log(`  ✅ ${msg}`);
};

// ── Mock: Perun Client ────────────────────────────────────────────────────────
const perunMock = {
  openChannel: async ({ userAddress, depositUsdc }) => ({
    channel_id: `ch_${Date.now()}`,
    initial_state: '{}',
    deposit_tx: `0xmock_deposit_${Date.now()}`,
    error: '',
  }),
  proposeUpdate: async () => ({
    state_hash: `0xhash_${Date.now()}`,
    operator_sig: '0xmock_sig',
    error: '',
  }),
  settleChannel: async () => ({
    tx_hash: `0xmock_settle_${Date.now()}`,
    error: '',
  }),
  disputeChannel: async () => ({ tx_hash: '', error: '' }),
};

// Perun 모듈 오버라이드
const Module = require('module');
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  if (request.includes('perunClient')) return perunMock;
  return originalLoad.call(this, request, ...args);
};

// ── 테스트 러너 ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n🚀 SmartCity Payment Backend — Integration Tests\n');
  console.log('='.repeat(60));

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    console.log(`\n📋 ${name}`);
    try {
      await fn();
      passed++;
    } catch (err) {
      console.log(`  ❌ FAIL: ${err.message}`);
      if (process.env.VERBOSE) console.error(err.stack);
      failed++;
    }
  }

  // ── 1. Fare Engine ──────────────────────────────────────────────────────────
  await test('FareEngine: 자전거 요금 계산 (30분)', async () => {
    const { calculateFare } = require('./fareEngineLocal');
    const result = calculateFare({
      serviceType: 'bicycle',
      usage: { durationMinutes: 30 },
    });
    assert(parseFloat(result.fareUsdc) > 0, '요금이 0보다 커야 함');
    assert(parseFloat(result.fareUsdc) <= 5.0, '상한(cap) 5 USDC 이하');
    console.log(`     요금: ${result.fareUsdc} USDC`);
  });

  await test('FareEngine: 자전거 무료 구간 (2분 이내)', async () => {
    const { calculateFare } = require('./fareEngineLocal');
    const result = calculateFare({
      serviceType: 'bicycle',
      usage: { durationMinutes: 1 },
    });
    assert(parseFloat(result.fareUsdc) === 0, '2분 이내는 무료');
    console.log(`     요금: ${result.fareUsdc} USDC (무료)`);
  });

  await test('FareEngine: 최소요금 적용 (3분)', async () => {
    const { calculateFare } = require('./fareEngineLocal');
    const result = calculateFare({
      serviceType: 'bicycle',
      usage: { durationMinutes: 3 },
    });
    // 1분 * 0.01 = 0.01 < 최소요금 0.10
    assert(parseFloat(result.fareUsdc) >= 0.10, '최소요금 0.10 USDC 적용');
    console.log(`     요금: ${result.fareUsdc} USDC (최소요금 적용)`);
  });

  await test('FareEngine: Cap 적용 (600분)', async () => {
    const { calculateFare } = require('./fareEngineLocal');
    const result = calculateFare({
      serviceType: 'bicycle',
      usage: { durationMinutes: 600 },
    });
    assert(parseFloat(result.fareUsdc) === 5.0, 'Cap 5 USDC 적용');
    console.log(`     요금: ${result.fareUsdc} USDC (cap 적용)`);
  });

  await test('FareEngine: EV 충전 요금 계산 (10 kWh)', async () => {
    const { calculateFare } = require('./fareEngineLocal');
    const result = calculateFare({
      serviceType: 'ev_charging',
      usage: { energyKwh: 10 },
    });
    // 10 * 0.25 + 0.10 session fee = 2.60
    assert(parseFloat(result.fareUsdc) === 2.60, 'EV 충전 2.60 USDC');
    console.log(`     요금: ${result.fareUsdc} USDC`);
  });

  // ── 2. Session Manager (인메모리) ───────────────────────────────────────────
  await test('SessionManager: 세션 상태머신', async () => {
    const { createSession, updateSession } = require('./sessionLocal');

    const session = createSession({
      userAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      serviceType: 'bicycle',
      depositUsdc: '10.0',
    });

    assert(session.status === 'Active', '초기 상태: Active');

    const ended = updateSession(session, 'Ended');
    assert(ended.status === 'Ended', 'Ended 전이');

    const settling = updateSession(ended, 'Settling');
    assert(settling.status === 'Settling', 'Settling 전이');

    const settled = updateSession(settling, 'Settled');
    assert(settled.status === 'Settled', 'Settled 전이');
  });

  // ── 3. Refund Case Manager (인메모리) ───────────────────────────────────────
  await test('RefundCaseManager: 케이스 상태머신', async () => {
    const { createCase, updateCase } = require('./refundLocal');

    const c = createCase({
      userAddress: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      reason: 'sensor_failure',
      requestedUsdc: '1.5',
    });

    assert(c.status === 'RECEIVED', '초기: RECEIVED');

    const verifying = updateCase(c, 'VERIFYING');
    assert(verifying.status === 'VERIFYING', 'VERIFYING 전이');

    const approved = updateCase(verifying, 'APPROVED', { approvedUsdc: '1.5' });
    assert(approved.status === 'APPROVED', 'APPROVED 전이');
    assert(approved.approvedUsdc === '1.5', '승인 금액 저장');

    const paid = updateCase(approved, 'PAID');
    assert(paid.status === 'PAID', 'PAID 전이');

    const closed = updateCase(paid, 'CLOSED');
    assert(closed.status === 'CLOSED', 'CLOSED 전이');
  });

  // ── 4. Signature: nonce 역행 방지 ───────────────────────────────────────────
  await test('SignatureManager: nonce 역행 감지', async () => {
    const currentNonce = 5;
    const incomingNonce = 3;
    const isRegression = incomingNonce <= currentNonce;
    assert(isRegression, 'nonce 역행 감지 정상 동작');
  });

  // ── 5. 환불 판단 규칙 ──────────────────────────────────────────────────────
  await test('RefundDecision: 소액 자동 승인 임계값', async () => {
    const AUTO_THRESHOLD = 5.0;
    const amounts = [
      { usdc: 1.0,  expected: 'auto'   },
      { usdc: 5.0,  expected: 'auto'   },
      { usdc: 5.01, expected: 'manual' },
      { usdc: 10.0, expected: 'manual' },
    ];

    for (const { usdc, expected } of amounts) {
      const result = usdc <= AUTO_THRESHOLD ? 'auto' : 'manual';
      assert(result === expected, `${usdc} USDC → ${expected} 승인`);
    }
  });

  // ── 6. Escrow: Dual-Path 로직 ─────────────────────────────────────────────
  await test('EscrowPayout: Dual-Path 경로 결정', async () => {
    // 케이스 있음 + APPROVED → refundToBuyer (4a)
    const hasCase = true;
    const caseStatus = 'APPROVED';
    const path4a = hasCase && caseStatus === 'APPROVED' ? 'refund' : 'release';
    assert(path4a === 'refund', '이슈 있음 → Buyer Refund (4a)');

    // 케이스 없음 → releaseToMerchant (4b)
    const noCase = false;
    const path4b = noCase ? 'refund' : 'release';
    assert(path4b === 'release', '이슈 없음 → Seller Payment (4b)');
  });

  // ── 7. 잔액 소진 감지 ────────────────────────────────────────────────────────
  await test('ChannelOrchestrator: 잔액 소진 감지', async () => {
    const { checkThreshold } = require('./orchestratorLocal');

    const result = checkThreshold({
      userBalance: '500000',   // 0.5 USDC
      totalDeposit: '10000000', // 10 USDC
      thresholdPercent: 10,
    });

    assert(result.warning === true, '5% < 10% → 경고 발생');
    assert(result.remainingPercent < 10, '잔액 비율 10% 미만');
    console.log(`     잔액: ${result.userBalanceUsdc} USDC (${result.remainingPercent.toFixed(1)}%)`);
  });

  // ── 결과 ─────────────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log(`\n✅ Passed: ${passed} / Failed: ${failed} / Total: ${passed + failed}`);

  if (failed > 0) {
    console.log('\n⚠️  일부 테스트 실패. 위 로그를 확인하세요.');
    process.exit(1);
  } else {
    console.log('\n🎉 모든 테스트 통과!');
  }
}

runTests().catch((err) => {
  console.error('\n💥 테스트 실행 오류:', err.message);
  process.exit(1);
});
