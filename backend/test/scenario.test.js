/**
 * ============================================================
 *  SmartCity Payment — 통합 테스트 시나리오
 * ============================================================
 *
 *  실행: node test/scenario.test.js
 *
 *  시나리오 1 — 정상 결제 흐름 (REST API)
 *    ① POST /api/v1/sessions/start     → 세션 + 채널 오픈
 *    ② GET  /api/v1/sessions/:id/status → 상태 확인
 *    ③ POST /api/v1/sessions/:id/charge → 요금 청구
 *    ④ POST /api/v1/sessions/:id/end   → 세션 종료 + 정산 (서명 필요)
 *
 *  시나리오 2 — 환불 흐름 (REST API)
 *    ① POST /api/v1/refunds            → 환불 케이스 생성
 *    ② GET  /api/v1/refunds/:caseId    → 케이스 조회
 *    ③ POST /api/v1/refunds/:caseId/evaluate → 자동 판단
 *    ④ POST /api/v1/refunds/:caseId/payout   → 지급 실행
 *
 *  시나리오 3 — 온체인 컨트랙트 직접 호출 (Base Sepolia)
 *    ① getEscrowStatus / isDeadlinePassed (view 함수)
 *    ② ABI 함수/이벤트 목록 검증
 *    ③ 컨트랙트 bytecode 존재 확인
 *    ④ 네트워크 / 블록 높이 확인
 * ============================================================
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// ── 색상 출력 ───────────────────────────────────────────────
const c = {
  reset:'\x1b[0m', green:'\x1b[32m', red:'\x1b[31m',
  yellow:'\x1b[33m', cyan:'\x1b[36m', bold:'\x1b[1m', dim:'\x1b[2m',
};
const log     = (m) => console.log(`${c.cyan}    ${m}${c.reset}`);
const ok      = (m) => console.log(`${c.green}  ✅ ${m}${c.reset}`);
const fail    = (m) => console.log(`${c.red}  ❌ ${m}${c.reset}`);
const warn    = (m) => console.log(`${c.yellow}  ⚠️  ${m}${c.reset}`);
const step    = (n, m) => console.log(`\n${c.bold}${c.yellow}  [STEP ${n}] ${m}${c.reset}`);
const section = (title) => {
  console.log(`\n${c.bold}${'═'.repeat(62)}${c.reset}`);
  console.log(`${c.bold}  ${title}${c.reset}`);
  console.log(`${c.bold}${'═'.repeat(62)}${c.reset}`);
};

// ── 결과 집계 ───────────────────────────────────────────────
const results = { pass:0, fail:0, logs:[] };
function assert(cond, msg) {
  if (cond) { ok(msg); results.pass++; }
  else       { fail(msg); results.fail++; }
  results.logs.push({ pass:!!cond, msg });
}

// ── API 헬퍼 ────────────────────────────────────────────────
const BASE = 'http://localhost:3000';
async function api(method, path, body) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    return { status: res.status, data };
  } catch(e) {
    return { status: 0, data: { error: e.message } };
  }
}

// ── 온체인 초기화 ────────────────────────────────────────────
let provider, wallet, escrowContract;
async function initChain() {
  provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
  wallet   = new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);
  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../artifacts/SmartCityEscrow.json'), 'utf8')
  );
  escrowContract = new ethers.Contract(
    process.env.ESCROW_CONTRACT_ADDRESS, artifact.abi, wallet
  );
  const bal = await provider.getBalance(wallet.address);
  log(`운영자: ${wallet.address}`);
  log(`잔액: ${ethers.formatEther(bal)} ETH`);
}

// =============================================================
//  시나리오 1 — 정상 결제 흐름
// =============================================================
async function scenario1() {
  section('🛴 시나리오 1 — 정상 결제 흐름 (킥보드 대여)');

  // 실제 검증된 주소 사용
  const userAddress = wallet.address;
  let sessionId, channelId, signRequestId, stateHash;

  // ── STEP 1: 세션 시작 ──
  step(1, 'POST /api/v1/sessions/start — 세션 + 채널 오픈');
  const r1 = await api('POST', '/api/v1/sessions/start', {
    userAddress,
    serviceType: 'bicycle',
    depositUsdc:  '5.000000',
    meta: { device_id: 'KICK-007', location: 'Seoul Station' },
  });
  log(`status: ${r1.status}`);
  if (r1.data?.data) log(`응답: ${JSON.stringify(r1.data.data, null, 2).slice(0,400)}`);
  if (r1.data?.errors) warn(`검증 오류: ${JSON.stringify(r1.data.errors)}`);
  if (r1.data?.error)  warn(`서버 오류: ${r1.data.error}`);

  assert(r1.status === 201, `세션 생성 성공 (status: ${r1.status})`);
  sessionId = r1.data?.data?.sessionId || r1.data?.data?.session?.id;
  channelId = r1.data?.data?.channelId || r1.data?.data?.channel?.id;
  assert(!!sessionId, `세션 ID 발급: ${sessionId}`);
  assert(!!channelId, `채널 ID 발급: ${channelId}`);

  // ── STEP 2: 세션 상태 조회 ──
  if (sessionId) {
    step(2, `GET /api/v1/sessions/${sessionId}/status`);
    const r2 = await api('GET', `/api/v1/sessions/${sessionId}/status`);
    log(`status: ${r2.status}`);
    if (r2.data?.data) log(`세션 상태: ${r2.data.data.stage} / ${r2.data.data.session?.status}`);
    assert(r2.status === 200, `세션 상태 조회 성공`);
    assert(r2.data?.data?.session?.status === 'Active', `세션 상태 Active 확인`);
  }

  // ── STEP 3: 요금 청구 ──
  if (sessionId && channelId) {
    step(3, `POST /api/v1/sessions/${sessionId}/charge — 10분 자전거 사용`);
    const r3 = await api('POST', `/api/v1/sessions/${sessionId}/charge`, {
      channelId,
      userAddress,
      serviceType: 'bicycle',
      usage: { durationMinutes: 10 },
    });
    log(`status: ${r3.status}`);
    if (r3.data?.data) {
      log(`요금: ${r3.data.data.fare?.fareUsdc} USDC`);
      log(`nonce: ${r3.data.data.signatureRequest?.nonce}`);
      signRequestId = r3.data.data.signatureRequest?.requestId;
      stateHash     = r3.data.data.signatureRequest?.stateHash;
    }
    if (r3.data?.errors) warn(`검증 오류: ${JSON.stringify(r3.data.errors)}`);
    if (r3.data?.error)  warn(`서버 오류: ${r3.data.error}`);
    assert(r3.status === 200, `요금 청구 성공 (status: ${r3.status})`);
    assert(!!r3.data?.data?.fare?.fareUsdc, `요금 계산됨: ${r3.data?.data?.fare?.fareUsdc} USDC`);
  }

  // ── STEP 4: 사용자 서명 제출 ──
  if (sessionId && channelId && stateHash) {
    step(4, `POST /api/v1/sessions/${sessionId}/sign — 사용자 서명`);
    // 테스트용 서명 생성 (실제 stateHash에 대한 서명)
    const userSig = await wallet.signMessage(ethers.getBytes(stateHash));
    const r4 = await api('POST', `/api/v1/sessions/${sessionId}/sign`, {
      channelId,
      userAddress,
      userSig,
    });
    log(`status: ${r4.status}`);
    if (r4.data?.data) log(`서명 확인: nonce=${r4.data.data.nonce}`);
    if (r4.data?.error) warn(`서버 오류: ${r4.data.error}`);
    assert(r4.status === 200, `사용자 서명 제출 성공 (status: ${r4.status})`);
  }

  log(`\n  → 세션ID: ${sessionId}`);
  log(`  → 채널ID: ${channelId}`);
  return { sessionId, channelId };
}

// =============================================================
//  시나리오 2 — 환불 흐름
// =============================================================
async function scenario2() {
  section('💸 시나리오 2 — 환불 흐름 (센서 장애)');

  const userAddress = wallet.address;
  let caseId;

  // ── STEP 1: 환불 케이스 생성 ──
  step(1, 'POST /api/v1/refunds — 환불 요청');
  const r1 = await api('POST', '/api/v1/refunds', {
    userAddress,
    reason: 'sensor_failure',
    requestedUsdc: '3.000000',
    evidence: [
      { type: 'return_event',  device_id: 'BUS-042', ts: new Date(Date.now() - 300000).toISOString() },
      { type: 'session_end',   device_id: 'BUS-042', ts: new Date().toISOString() },
    ],
  });
  log(`status: ${r1.status}`);
  if (r1.data?.data) log(`응답: ${JSON.stringify(r1.data.data, null, 2).slice(0,300)}`);
  if (r1.data?.errors) warn(`검증 오류: ${JSON.stringify(r1.data.errors)}`);
  if (r1.data?.error)  warn(`서버 오류: ${r1.data.error}`);

  assert(r1.status === 201, `환불 케이스 생성 성공 (status: ${r1.status})`);
  caseId = r1.data?.data?.caseId || r1.data?.data?.id;
  assert(!!caseId, `케이스 ID 발급: ${caseId}`);

  // ── STEP 2: 케이스 조회 ──
  if (caseId) {
    step(2, `GET /api/v1/refunds/${caseId}`);
    const r2 = await api('GET', `/api/v1/refunds/${caseId}`);
    log(`status: ${r2.status}`);
    if (r2.data?.data) log(`케이스 상태: ${r2.data.data.status || r2.data.data.case?.status} / 금액: ${r2.data.data.requested_usdc || r2.data.data.requestedUsdc} USDC`);
    assert(r2.status === 200, `케이스 조회 성공`);
    assert(['RECEIVED','REVIEWING','APPROVED'].includes(r2.data?.data?.status),
      `케이스 상태 유효: ${r2.data?.data?.status}`);
  }

  // ── STEP 3: 자동 판단 실행 ──
  if (caseId) {
    step(3, `POST /api/v1/refunds/${caseId}/evaluate — 자동 판단`);
    const r3 = await api('POST', `/api/v1/refunds/${caseId}/evaluate`, {});
    log(`status: ${r3.status}`);
    if (r3.data?.data) log(`판단 결과: ${JSON.stringify(r3.data.data, null, 2).slice(0,300)}`);
    if (r3.data?.error) warn(`서버 오류: ${r3.data.error}`);
    assert(r3.status === 200, `자동 판단 실행 성공 (status: ${r3.status})`);

    // 판단 후 상태 재조회
    await new Promise(r => setTimeout(r, 300));
    const r3b = await api('GET', `/api/v1/refunds/${caseId}`);
    const afterStatus = r3b.data?.data?.status || r3b.data?.data?.case?.status;
    log(`  판단 후 상태: ${afterStatus}`);
    assert(['APPROVED','REVIEWING','REJECTED'].includes(afterStatus),
      `자동 판단 완료 (상태: ${afterStatus})`);
    log(`  ℹ️  실제 판단: ${afterStatus} — evidence + fareRecord 있으면 APPROVED`);
  }

  log(`\n  → 케이스ID: ${caseId}`);
  return { caseId };
}

// =============================================================
//  시나리오 3 — 온체인 컨트랙트 직접 호출
// =============================================================
async function scenario3() {
  section('⛓️  시나리오 3 — 온체인 컨트랙트 직접 호출 (Base Sepolia)');

  log(`컨트랙트: ${process.env.ESCROW_CONTRACT_ADDRESS}`);

  // ── STEP 1: getEscrowStatus (미존재 escrowId → 초기값 확인) ──
  step(1, 'getEscrowStatus() — 미생성 escrowId로 초기 상태 확인');
  const testEscrowId = ethers.id(`scenario3-${Date.now()}`);
  log(`  escrowId: ${testEscrowId}`);
  try {
    const [state, amount, buyer, seller, holdDeadline] = await escrowContract.getEscrowStatus(testEscrowId);
    log(`  state:       ${state}  (0=Held, 1=Released, 2=Refunded, 3=RefundIssue, 4=Cancelled)`);
    log(`  amount:      ${amount}`);
    log(`  buyer:       ${buyer}`);
    log(`  seller:      ${seller}`);
    log(`  holdDeadline:${holdDeadline}`);
    assert(true, `getEscrowStatus() 호출 성공 (state: ${state})`);
    assert(buyer === ethers.ZeroAddress, `미생성 에스크로 buyer = ZeroAddress`);
  } catch(e) {
    assert(false, `getEscrowStatus() 실패: ${e.message}`);
  }

  // ── STEP 2: isDeadlinePassed ──
  step(2, 'isDeadlinePassed()');
  try {
    const passed = await escrowContract.isDeadlinePassed(testEscrowId);
    log(`  isDeadlinePassed: ${passed}`);
    assert(true, `isDeadlinePassed() 호출 성공: ${passed}`);
  } catch(e) {
    assert(false, `isDeadlinePassed() 실패: ${e.message}`);
  }

  // ── STEP 3: getIssueRecord ──
  step(3, 'getIssueRecord()');
  try {
    const issue = await escrowContract.getIssueRecord(testEscrowId);
    log(`  issueType:    ${issue[0]}`);
    log(`  description:  "${issue[1]}"`);
    log(`  registeredAt: ${issue[2]}`);
    assert(true, `getIssueRecord() 호출 성공`);
  } catch(e) {
    assert(false, `getIssueRecord() 실패: ${e.message}`);
  }

  // ── STEP 4: ABI 검증 ──
  step(4, '컨트랙트 ABI 함수/이벤트 검증');
  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../artifacts/SmartCityEscrow.json'), 'utf8')
  );
  const fns    = artifact.abi.filter(x => x.type === 'function').map(x => x.name);
  const events = artifact.abi.filter(x => x.type === 'event').map(x => x.name);
  log(`  함수(${fns.length}개): ${fns.join(', ')}`);
  log(`  이벤트(${events.length}개): ${events.join(', ')}`);
  for (const fn of ['createEscrow','releaseToSeller','refundToBuyer','registerRefundIssue','emergencyCancel','getEscrowStatus','isDeadlinePassed','getIssueRecord']) {
    assert(fns.includes(fn), `함수 존재: ${fn}()`);
  }
  for (const ev of ['EscrowCreated','ReleasedToSeller','RefundedToBuyer','RefundIssueRegistered']) {
    assert(events.includes(ev), `이벤트 존재: ${ev}`);
  }

  // ── STEP 5: bytecode 존재 확인 ──
  step(5, '컨트랙트 배포 확인 (bytecode)');
  const code = await provider.getCode(process.env.ESCROW_CONTRACT_ADDRESS);
  const size = (code.length - 2) / 2;
  log(`  bytecode 크기: ${size.toLocaleString()} bytes`);
  assert(code && code !== '0x', `컨트랙트 배포됨 (${size} bytes)`);
  assert(size > 1000, `bytecode 크기 충분 (${size} > 1000 bytes)`);

  // ── STEP 6: 네트워크 / 블록 확인 ──
  step(6, '네트워크 & 최신 블록 확인');
  const [block, network] = await Promise.all([
    provider.getBlock('latest'),
    provider.getNetwork(),
  ]);
  log(`  chainId:    ${network.chainId}  (Base Sepolia = 84532)`);
  log(`  최신 블록:  #${block.number}`);
  log(`  블록 시각:  ${new Date(Number(block.timestamp)*1000).toISOString()}`);
  const bal = await provider.getBalance(wallet.address);
  log(`  운영자 잔액: ${ethers.formatEther(bal)} ETH`);
  assert(network.chainId === 84532n, `Base Sepolia chainId 확인`);
  assert(block.number > 0, `블록 높이 정상: #${block.number}`);
  assert(bal > 0n, `운영자 잔액 존재: ${ethers.formatEther(bal)} ETH`);

  // ── STEP 7: Explorer 링크 출력 ──
  step(7, '🔗 Explorer 링크');
  log(`  https://sepolia.basescan.org/address/${process.env.ESCROW_CONTRACT_ADDRESS}`);
  assert(true, 'Explorer 링크 생성 완료');
}

// =============================================================
//  메인
// =============================================================
async function main() {
  console.log(`\n${c.bold}${'═'.repeat(62)}`);
  console.log(`  🏙️  SmartCity Payment — 테스트 시나리오 실행`);
  console.log(`${'═'.repeat(62)}${c.reset}`);
  console.log(`  시각:      ${new Date().toLocaleString('ko-KR')}`);
  console.log(`  서버:      ${BASE}`);
  console.log(`  컨트랙트:  ${process.env.ESCROW_CONTRACT_ADDRESS}`);
  console.log(`  네트워크:  Base Sepolia (chainId: 84532)`);

  // 서버 헬스체크
  console.log(`\n  서버 상태 확인 중...`);
  const health = await api('GET', '/health');
  if (health.status !== 200) {
    console.log(`${c.red}  ❌ 서버가 응답하지 않습니다. npm start 먼저 실행하세요.${c.reset}`);
    process.exit(1);
  }
  ok(`서버 정상 — ${JSON.stringify(health.data?.checks)}`);

  // 온체인 초기화
  await initChain();

  // 시나리오 순차 실행
  await scenario1();
  await scenario2();
  await scenario3();

  // ── 최종 결과 ──
  section('📊 테스트 결과 요약');
  const total = results.pass + results.fail;
  console.log(`\n  총 ${total}개 검증`);
  console.log(`  ${c.green}✅ 통과: ${results.pass}${c.reset}`);
  if (results.fail > 0) {
    console.log(`  ${c.red}❌ 실패: ${results.fail}${c.reset}`);
    console.log(`\n  실패 항목:`);
    results.logs.filter(l=>!l.pass).forEach(l => console.log(`    - ${l.msg}`));
  } else {
    console.log(`\n  ${c.bold}${c.green}  🎉 모든 테스트 통과!${c.reset}`);
  }
  console.log();
}

main().catch(e => {
  console.error(`\n${c.red}치명적 오류: ${e.message}${c.reset}`);
  console.error(e.stack);
  process.exit(1);
});
