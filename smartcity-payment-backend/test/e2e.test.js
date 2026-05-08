/**
 * E2E Integration Test — 실제 DB (PostgreSQL + Redis) 연동
 * 실행: node test/e2e.test.js
 *
 * 테스트 시나리오:
 *  1. PostgreSQL 연결 및 테이블 확인
 *  2. Redis 연결 및 read/write
 *  3. 채널 생성 → 상태 업데이트 → 조회 (channels 테이블)
 *  4. 채널 상태 Redis 저장 → 조회 → 삭제
 *  5. 세션 생성 → 조회 (sessions 테이블)
 *  6. 요금 계산 기록 저장 (fare_calculations 테이블)
 *  7. 서명 요청 저장 (signature_requests 테이블)
 *  8. 정산 레코드 저장 (settlements 테이블)
 *  9. 환불 케이스 생성 → 상태 전이 (refund_cases 테이블)
 * 10. 에스크로 잠금 레코드 생성 → 상태 전이 (escrow_locks 테이블)
 * 11. 전체 흐름 통합 (세션 → 정산 → 에스크로 → 환불)
 * 12. 테스트 데이터 정리 (Cleanup)
 */

require('dotenv').config();
const { Pool } = require('pg');
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

// ── 색상 ──────────────────────────────────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[34m', RESET = '\x1b[0m', BOLD = '\x1b[1m';

let passed = 0, failed = 0;
const createdIds = { channels: [], sessions: [], cases: [] };

function ok(msg)   { console.log(`${G}  ✅ ${msg}${RESET}`); passed++; }
function fail(msg, err) { console.log(`${R}  ❌ ${msg}${RESET}`); if (err) console.log(`     ${err.message}`); failed++; }

async function test(name, fn) {
  try { await fn(); }
  catch (err) { fail(name, err); }
}

// ── DB 클라이언트 ─────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase.com') ? { rejectUnauthorized: false } : false,
});

const redis = new Redis(process.env.REDIS_URL, {
  tls: {},
  lazyConnect: true,
  connectTimeout: 10000,
  retryStrategy: () => null,
});

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${BOLD}${B}🧪 SmartCity Payment Backend — E2E DB 연동 테스트${RESET}\n`);

  // ── 1. PostgreSQL 연결 ───────────────────────────────────────────────────────
  console.log(`${Y}[1] PostgreSQL 연결${RESET}`);
  await test('PostgreSQL ping', async () => {
    const res = await pool.query('SELECT 1 AS ping');
    if (res.rows[0].ping !== 1) throw new Error('ping 실패');
    ok('PostgreSQL 연결 정상');
  });

  await test('테이블 10개 존재 확인', async () => {
    const res = await pool.query(`
      SELECT count(*) FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'channels','channel_states','sessions','fare_policies',
          'fare_calculations','signature_requests','settlements',
          'refund_cases','escrow_locks','refund_transactions'
        )
    `);
    const cnt = parseInt(res.rows[0].count);
    if (cnt !== 10) throw new Error(`테이블 ${cnt}개 (10개 필요)`);
    ok(`테이블 10개 모두 존재`);
  });

  // ── 2. Redis 연결 ────────────────────────────────────────────────────────────
  console.log(`\n${Y}[2] Redis 연결${RESET}`);
  await redis.connect();
  await test('Redis ping', async () => {
    const pong = await redis.ping();
    if (pong !== 'PONG') throw new Error('ping 실패');
    ok('Redis 연결 정상');
  });

  // ── 3. Channel CRUD ──────────────────────────────────────────────────────────
  console.log(`\n${Y}[3] Channel CRUD${RESET}`);
  const channelId = `ch_e2e_${uuidv4().slice(0, 8)}`;
  const userAddr  = '0xUserE2E000000000000000000000000000000001';
  const opAddr    = '0xOperatorE2E00000000000000000000000000001';
  createdIds.channels.push(channelId);

  await test('채널 생성', async () => {
    await pool.query(
      `INSERT INTO channels (id, user_address, operator_address, deposit_usdc, opened_tx)
       VALUES ($1, $2, $3, $4, $5)`,
      [channelId, userAddr, opAddr, '10.000000', '0xOpenTxHash']
    );
    ok(`채널 생성: ${channelId}`);
  });

  await test('채널 조회', async () => {
    const res = await pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
    if (!res.rows[0]) throw new Error('채널 없음');
    if (res.rows[0].status !== 'open') throw new Error('초기 status 오류');
    ok(`채널 조회 — status: ${res.rows[0].status}, deposit: ${res.rows[0].deposit_usdc}`);
  });

  await test('채널 상태 업데이트 (open → closed)', async () => {
    await pool.query(
      `UPDATE channels SET status = 'closed', settled_tx = $2, updated_at = NOW() WHERE id = $1`,
      [channelId, '0xSettleTxHash']
    );
    const res = await pool.query('SELECT status, settled_tx FROM channels WHERE id = $1', [channelId]);
    if (res.rows[0].status !== 'closed') throw new Error('status 업데이트 실패');
    ok(`채널 상태 → closed, settled_tx 저장`);
  });

  await test('채널 상태 히스토리 저장', async () => {
    await pool.query(
      `INSERT INTO channel_states (channel_id, nonce, balance_user, balance_operator, user_sig, operator_sig)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [channelId, 5, '3.500000', '6.500000', '0xUserSig', '0xOpSig']
    );
    ok('channel_states 히스토리 저장');
  });

  // ── 4. Redis Channel State ───────────────────────────────────────────────────
  console.log(`\n${Y}[4] Redis Channel State${RESET}`);
  const redisKey = `channel:${channelId}`;
  const state = { nonce: 5, balances: { user: '3.5', operator: '6.5' }, updatedAt: Date.now() };

  await test('Redis 채널 상태 저장', async () => {
    await redis.set(redisKey, JSON.stringify(state), 'EX', 3600);
    ok('Redis 채널 상태 저장');
  });

  await test('Redis 채널 상태 조회', async () => {
    const raw = await redis.get(redisKey);
    const parsed = JSON.parse(raw);
    if (parsed.nonce !== 5) throw new Error('nonce 불일치');
    if (parsed.balances.user !== '3.5') throw new Error('balance 불일치');
    ok(`Redis 채널 상태 조회 — nonce: ${parsed.nonce}, user: ${parsed.balances.user}`);
  });

  await test('Redis 채널 상태 삭제', async () => {
    await redis.del(redisKey);
    const val = await redis.get(redisKey);
    if (val !== null) throw new Error('삭제 실패');
    ok('Redis 채널 상태 삭제');
  });

  // ── 5. Session CRUD ──────────────────────────────────────────────────────────
  console.log(`\n${Y}[5] Session CRUD${RESET}`);
  const sessionId = `sess_e2e_${uuidv4().slice(0, 8)}`;
  createdIds.sessions.push(sessionId);

  await test('세션 생성', async () => {
    await pool.query(
      `INSERT INTO sessions (id, user_address, service_type, channel_id, deposit_usdc, status)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, userAddr, 'escooter', channelId, '5.000000', 'Active']
    );
    ok(`세션 생성: ${sessionId}`);
  });

  await test('세션 조회', async () => {
    const res = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
    if (!res.rows[0]) throw new Error('세션 없음');
    if (res.rows[0].service_type !== 'escooter') throw new Error('service_type 오류');
    ok(`세션 조회 — service_type: ${res.rows[0].service_type}, status: ${res.rows[0].status}`);
  });

  await test('세션 상태 업데이트 (Active → Settled)', async () => {
    await pool.query(
      `UPDATE sessions SET status = 'Settled', ended_at = NOW(), settled_at = NOW() WHERE id = $1`,
      [sessionId]
    );
    const res = await pool.query('SELECT status FROM sessions WHERE id = $1', [sessionId]);
    if (res.rows[0].status !== 'Settled') throw new Error('status 업데이트 실패');
    ok('세션 상태 → Settled');
  });

  // ── 6. Fare Calculation ──────────────────────────────────────────────────────
  console.log(`\n${Y}[6] Fare Calculation${RESET}`);
  await test('요금 계산 기록 저장', async () => {
    await pool.query(
      `INSERT INTO fare_calculations
       (session_id, policy_id, policy_version, usage_data, base_fare, adjustments, final_fare)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        sessionId, 'policy_escooter_v1', '1.0.0',
        JSON.stringify({ distance_km: 3.2, duration_min: 18 }),
        '2.500000',
        JSON.stringify([{ type: 'peak_hour', amount: '0.500000' }]),
        '3.000000'
      ]
    );
    const res = await pool.query('SELECT * FROM fare_calculations WHERE session_id = $1', [sessionId]);
    if (!res.rows[0]) throw new Error('저장 실패');
    ok(`요금 계산 저장 — base: ${res.rows[0].base_fare}, final: ${res.rows[0].final_fare}`);
  });

  // ── 7. Signature Request ──────────────────────────────────────────────────────
  console.log(`\n${Y}[7] Signature Request${RESET}`);
  await test('서명 요청 저장', async () => {
    await pool.query(
      `INSERT INTO signature_requests
       (channel_id, session_id, nonce, state_hash, charge_usdc, status, user_sig, operator_sig)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [channelId, sessionId, 5, '0xStateHash123', '3.000000', 'signed', '0xUserSig', '0xOpSig']
    );
    const res = await pool.query('SELECT * FROM signature_requests WHERE channel_id = $1 ORDER BY id DESC LIMIT 1', [channelId]);
    if (!res.rows[0]) throw new Error('저장 실패');
    if (res.rows[0].status !== 'signed') throw new Error('status 오류');
    ok(`서명 요청 저장 — nonce: ${res.rows[0].nonce}, status: ${res.rows[0].status}`);
  });

  // ── 8. Settlement ─────────────────────────────────────────────────────────────
  console.log(`\n${Y}[8] Settlement${RESET}`);
  await test('정산 레코드 저장', async () => {
    await pool.query(
      `INSERT INTO settlements
       (session_id, channel_id, tx_hash, status, final_nonce, user_refund_usdc, operator_earn_usdc, final_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        sessionId, channelId, '0xSettleTx', 'confirmed', 5,
        '2.000000', '3.000000',
        JSON.stringify({ nonce: 5, balances: { user: '2.0', operator: '3.0' } })
      ]
    );
    const res = await pool.query('SELECT * FROM settlements WHERE session_id = $1', [sessionId]);
    if (!res.rows[0]) throw new Error('저장 실패');
    ok(`정산 저장 — operator_earn: ${res.rows[0].operator_earn_usdc}, status: ${res.rows[0].status}`);
  });

  // ── 9. Refund Case 상태 전이 ──────────────────────────────────────────────────
  console.log(`\n${Y}[9] Refund Case 상태 전이${RESET}`);
  const caseId = `case_e2e_${uuidv4().slice(0, 8)}`;
  createdIds.cases.push(caseId);

  await test('환불 케이스 생성 (RECEIVED)', async () => {
    await pool.query(
      `INSERT INTO refund_cases
       (id, session_id, channel_id, user_address, reason, status, requested_usdc)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [caseId, sessionId, channelId, userAddr, 'sensor_failure', 'RECEIVED', '3.000000']
    );
    const res = await pool.query('SELECT status FROM refund_cases WHERE id = $1', [caseId]);
    if (res.rows[0].status !== 'RECEIVED') throw new Error('초기 status 오류');
    ok(`환불 케이스 생성 — status: RECEIVED`);
  });

  await test('환불 케이스 RECEIVED → REVIEWING', async () => {
    await pool.query(`UPDATE refund_cases SET status = 'REVIEWING', updated_at = NOW() WHERE id = $1`, [caseId]);
    const res = await pool.query('SELECT status FROM refund_cases WHERE id = $1', [caseId]);
    if (res.rows[0].status !== 'REVIEWING') throw new Error('전이 실패');
    ok('케이스 상태 → REVIEWING');
  });

  await test('환불 케이스 REVIEWING → APPROVED', async () => {
    await pool.query(
      `UPDATE refund_cases SET status = 'APPROVED', approved_usdc = $2, reviewer_notes = $3, updated_at = NOW() WHERE id = $1`,
      [caseId, '3.000000', '센서 오류 확인 완료 — 전액 환불 승인']
    );
    const res = await pool.query('SELECT status, approved_usdc FROM refund_cases WHERE id = $1', [caseId]);
    if (res.rows[0].status !== 'APPROVED') throw new Error('전이 실패');
    ok(`케이스 상태 → APPROVED, approved_usdc: ${res.rows[0].approved_usdc}`);
  });

  await test('환불 케이스 APPROVED → PAID → CLOSED', async () => {
    await pool.query(
      `UPDATE refund_cases SET status = 'PAID', paid_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [caseId]
    );
    await pool.query(
      `UPDATE refund_cases SET status = 'CLOSED', closed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [caseId]
    );
    const res = await pool.query('SELECT status, closed_at FROM refund_cases WHERE id = $1', [caseId]);
    if (res.rows[0].status !== 'CLOSED') throw new Error('전이 실패');
    ok('케이스 상태 → PAID → CLOSED');
  });

  // ── 10. Escrow Lock 상태 전이 ─────────────────────────────────────────────────
  console.log(`\n${Y}[10] Escrow Lock 상태 전이${RESET}`);
  const escrowBytes = '0x' + Buffer.from(sessionId).toString('hex').slice(0, 64).padEnd(64, '0');
  const holdDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);

  await test('에스크로 잠금 생성 (Held)', async () => {
    await pool.query(
      `INSERT INTO escrow_locks
       (session_id, escrow_id_bytes, channel_id, case_id, user_address, seller_address,
        amount_usdc, hold_deadline, create_tx, state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [sessionId, escrowBytes, channelId, caseId, userAddr, opAddr,
       '3.000000', holdDeadline, '0xCreateEscrowTx', 'Held']
    );
    const res = await pool.query('SELECT state FROM escrow_locks WHERE session_id = $1', [sessionId]);
    if (res.rows[0].state !== 'Held') throw new Error('초기 state 오류');
    ok('에스크로 잠금 생성 — state: Held');
  });

  await test('에스크로 Held → RefundIssue', async () => {
    await pool.query(`UPDATE escrow_locks SET state = 'RefundIssue' WHERE session_id = $1`, [sessionId]);
    const res = await pool.query('SELECT state FROM escrow_locks WHERE session_id = $1', [sessionId]);
    if (res.rows[0].state !== 'RefundIssue') throw new Error('전이 실패');
    ok('에스크로 상태 → RefundIssue');
  });

  await test('에스크로 RefundIssue → Refunded (Buyer 환불)', async () => {
    await pool.query(
      `UPDATE escrow_locks SET state = 'Refunded', release_tx = $2, released_at = NOW() WHERE session_id = $1`,
      [sessionId, '0xRefundToBuyerTx']
    );
    const res = await pool.query('SELECT state, release_tx FROM escrow_locks WHERE session_id = $1', [sessionId]);
    if (res.rows[0].state !== 'Refunded') throw new Error('전이 실패');
    ok(`에스크로 상태 → Refunded, tx: ${res.rows[0].release_tx}`);
  });

  // ── 11. 전체 흐름 통합 확인 ───────────────────────────────────────────────────
  console.log(`\n${Y}[11] 전체 흐름 JOIN 조회${RESET}`);
  await test('세션 + 정산 + 에스크로 + 케이스 JOIN', async () => {
    const res = await pool.query(`
      SELECT
        s.id           AS session_id,
        s.status       AS session_status,
        s.service_type,
        st.status      AS settlement_status,
        st.operator_earn_usdc,
        el.state       AS escrow_state,
        el.amount_usdc AS escrow_amount,
        rc.status      AS case_status,
        rc.approved_usdc
      FROM sessions s
      LEFT JOIN settlements    st ON st.session_id = s.id
      LEFT JOIN escrow_locks   el ON el.session_id = s.id
      LEFT JOIN refund_cases   rc ON rc.session_id = s.id
      WHERE s.id = $1
    `, [sessionId]);

    const row = res.rows[0];
    if (!row) throw new Error('JOIN 결과 없음');

    console.log(`\n     ${BOLD}── 통합 조회 결과 ────────────────────────${RESET}`);
    console.log(`     세션:      ${row.session_id} (${row.service_type})`);
    console.log(`     세션상태:  ${row.session_status}`);
    console.log(`     정산상태:  ${row.settlement_status} | 운영자수익: ${row.operator_earn_usdc} USDC`);
    console.log(`     에스크로:  ${row.escrow_state} | ${row.escrow_amount} USDC`);
    console.log(`     환불케이스: ${row.case_status} | 승인금액: ${row.approved_usdc} USDC`);
    console.log(`     ${BOLD}──────────────────────────────────────────${RESET}\n`);

    ok('전체 흐름 JOIN 조회 성공');
  });

  // ── 12. Cleanup ───────────────────────────────────────────────────────────────
  console.log(`${Y}[12] 테스트 데이터 정리${RESET}`);
  await test('테스트 데이터 삭제', async () => {
    for (const sid of createdIds.sessions) {
      await pool.query('DELETE FROM escrow_locks      WHERE session_id = $1', [sid]);
      await pool.query('DELETE FROM refund_cases      WHERE session_id = $1', [sid]);
      await pool.query('DELETE FROM settlements       WHERE session_id = $1', [sid]);
      await pool.query('DELETE FROM fare_calculations WHERE session_id = $1', [sid]);
      await pool.query('DELETE FROM signature_requests WHERE session_id = $1', [sid]);
      await pool.query('DELETE FROM sessions          WHERE id = $1',          [sid]);
    }
    for (const cid of createdIds.channels) {
      await pool.query('DELETE FROM channel_states WHERE channel_id = $1', [cid]);
      await pool.query('DELETE FROM channels       WHERE id = $1',          [cid]);
    }
    ok('테스트 데이터 정리 완료');
  });

  // ── 결과 ─────────────────────────────────────────────────────────────────────
  await redis.quit();
  await pool.end();

  console.log(`\n${'='.repeat(52)}`);
  console.log(`${BOLD}✅ Passed: ${G}${passed}${RESET}${BOLD}  ❌ Failed: ${R}${failed}${RESET}`);
  console.log(failed === 0
    ? `${G}${BOLD}🎉 전체 E2E 테스트 통과!${RESET}`
    : `${R}${BOLD}⚠️  일부 테스트 실패${RESET}`);
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`\n${R}💥 E2E 테스트 실행 오류:${RESET}`, err.message);
  process.exit(1);
});
