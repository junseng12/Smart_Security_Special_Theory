/**
 * perunClient.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Node.js ↔ Go Perun 노드 gRPC 브릿지
 *
 * Proto: src/proto/smartcity.proto  (go-perun-node와 완전 동기화)
 * Service: SmartCityNode
 *
 * 환경변수:
 *   PERUN_GRPC_HOST  — go-perun 노드 호스트 (예: localhost, railway 내부 주소)
 *   PERUN_GRPC_PORT  — go-perun 노드 포트 (기본 50051)
 *
 * PERUN_GRPC_HOST 미설정 시 → MOCK 모드 (기존 테스트 호환 유지)
 */

'use strict';

const path    = require('path');
const grpc    = require('@grpc/grpc-js');
const loader  = require('@grpc/proto-loader');
const logger  = require('../utils/logger');

const PROTO_PATH = path.join(__dirname, '../proto/smartcity.proto');

// ── gRPC 스텁 ────────────────────────────────────────────────────────────────

let stub   = null;   // SmartCityNode gRPC stub
let _mode  = 'mock'; // 'grpc' | 'mock'

function initGrpc() {
  const host = process.env.PERUN_GRPC_HOST;
  const port = process.env.PERUN_GRPC_PORT || '50051';

  if (!host || host === 'undefined') {
    logger.info('[perunClient] PERUN_GRPC_HOST 미설정 → MOCK 모드');
    _mode = 'mock';
    return;
  }

  try {
    const pkgDef = loader.loadSync(PROTO_PATH, {
      keepCase:  true,
      longs:     String,
      enums:     String,
      defaults:  true,
      oneofs:    true,
    });
    const proto  = grpc.loadPackageDefinition(pkgDef).smartcity;
    const target = `${host}:${port}`;
    stub  = new proto.SmartCityNode(target, grpc.credentials.createInsecure());
    _mode = 'grpc';
    logger.info(`[perunClient] gRPC 연결 → ${target}`);
  } catch (err) {
    logger.warn('[perunClient] gRPC 초기화 실패 → MOCK 모드', { error: err.message });
    _mode = 'mock';
  }
}

initGrpc();

// ── gRPC 호출 헬퍼 ───────────────────────────────────────────────────────────

function call(method, req, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    if (!stub) return reject(new Error('gRPC stub 초기화 안됨'));
    const deadline = new Date(Date.now() + timeoutMs);
    stub[method](req, { deadline }, (err, res) => {
      if (err) return reject(err);
      if (res && !res.ok && res.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

// ── MOCK 응답 ────────────────────────────────────────────────────────────────
// go-perun 노드 없이도 기존 흐름 유지

const { v4: uuidv4 } = require('uuid');

const mock = {
  StartSession(req) {
    const sessionId  = `sess_${uuidv4().slice(0,8)}`;
    const channelId  = `0x${Buffer.from(sessionId).toString('hex').slice(0,64).padEnd(64,'0')}`;
    const stateHash  = `0x${Buffer.from('init').toString('hex').padEnd(64,'0')}`;
    logger.info('[MOCK] StartSession', { sessionId, channelId });
    return {
      ok:            true,
      session_id:    sessionId,
      channel_id:    channelId,
      escrow_id:     `escrow_${sessionId}`,
      hold_deadline: Math.floor(Date.now() / 1000) + (req.hold_seconds || 120),
      state_hash:    stateHash,
    };
  },
  EndSession(req) {
    logger.info('[MOCK] EndSession', { session_id: req.session_id });
    return { ok: true, fare_usdc: '0.05', refund_usdc: '0.0' };
  },
  ProposeUsageUpdate(req) {
    logger.info('[MOCK] ProposeUsageUpdate', { session_id: req.session_id });
    return {
      ok:           true,
      fare_usdc:    '0.01',
      policy_hash:  '0xpolicy',
      new_nonce:    1,
      state_hash:   '0xstatehash',
      balance_user: String(parseFloat(req.deposit_usdc || '1') - 0.01),
    };
  },
  GetChannelStatus(req) {
    return { ok: true, nonce: 1, balance_user: '0.99', balance_op: '0.01', state_hash: '0x' };
  },
  InitiateDispute(req) {
    logger.warn('[MOCK] InitiateDispute', { channel_id: req.channel_id });
    return { ok: true };
  },
  AccumulateCredit(req) {
    return { ok: true, total: req.credit_usdc };
  },
  PostCompensation(req) {
    return { ok: true, tx_hash: '0xmock' };
  },
};

function runMock(method, req) {
  if (mock[method]) return Promise.resolve(mock[method](req));
  return Promise.reject(new Error(`Mock not implemented: ${method}`));
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * 세션 시작 + 채널 개설
 * go-perun: ProposeChannel → Funder.Fund() → ERC20Depositor (approve + deposit)
 */
async function startSession({ userAddress, serviceId, depositUsdc, userWireAddr = '', holdSeconds = 120 }) {
  const req = {
    user_address:   userAddress,
    service_id:     serviceId,
    deposit_usdc:   depositUsdc,
    user_wire_addr: userWireAddr,
    hold_seconds:   holdSeconds,
  };
  if (_mode === 'mock') return runMock('StartSession', req);
  return call('StartSession', req, 30_000); // 온체인 tx 포함 → 30초
}

/**
 * 세션 종료 + 채널 정산
 * go-perun: FinalUpdate(IsFinal=true) → ch.Settle() → Adjudicator.conclude() → withdraw
 */
async function endSession({ sessionId, channelId, userAddress, userFinalSig = '' }) {
  const req = {
    session_id:     sessionId,
    channel_id:     channelId,
    user_address:   userAddress,
    user_final_sig: userFinalSig,
  };
  if (_mode === 'mock') return runMock('EndSession', req);
  return call('EndSession', req, 60_000); // 온체인 정산 → 60초
}

/**
 * 오프체인 요금 청구 (1분마다 호출)
 * go-perun: ch.Update(TransferBalance user→operator) — 가스비 0
 */
async function proposeUsageUpdate({ sessionId, channelId, serviceType, durationMinutes, energyKwh = 0 }) {
  const req = {
    session_id: sessionId,
    channel_id: channelId,
    usage_delta: {
      service_type:     serviceType,
      duration_minutes: durationMinutes,
      energy_kwh:       energyKwh,
    },
  };
  if (_mode === 'mock') return runMock('ProposeUsageUpdate', req);
  return call('ProposeUsageUpdate', req, 10_000);
}

/**
 * 채널 상태 조회
 */
async function getChannelStatus({ channelId }) {
  const req = { channel_id: channelId };
  if (_mode === 'mock') return runMock('GetChannelStatus', req);
  return call('GetChannelStatus', req);
}

/**
 * 분쟁 등록 — go-perun: ch.Register() → Adjudicator.register()
 */
async function initiateDispute({ channelId }) {
  const req = { channel_id: channelId };
  if (_mode === 'mock') return runMock('InitiateDispute', req);
  return call('InitiateDispute', req, 30_000);
}

/**
 * 크레딧 누적 (환불 포인트)
 */
async function accumulateCredit({ channelId, creditUsdc, reason }) {
  const req = { channel_id: channelId, credit_usdc: creditUsdc, reason };
  if (_mode === 'mock') return runMock('AccumulateCredit', req);
  return call('AccumulateCredit', req);
}

/**
 * 운영자 보상 지급
 */
async function postCompensation({ userAddress, amountUsdc, reason }) {
  const req = { user_address: userAddress, amount_usdc: amountUsdc, reason };
  if (_mode === 'mock') return runMock('PostCompensation', req);
  return call('PostCompensation', req);
}

/**
 * Perun 노드 헬스체크
 */
async function ping() {
  if (_mode === 'mock') return { connected: false, mode: 'mock' };
  try {
    await call('GetChannelStatus', { channel_id: 'ping' }, 2_000);
    return { connected: true, mode: 'grpc' };
  } catch (err) {
    // "channel not found" 에러는 연결은 됐다는 뜻
    if (err.message?.includes('not found') || err.code === grpc.status.NOT_FOUND) {
      return { connected: true, mode: 'grpc' };
    }
    return { connected: false, mode: 'grpc', error: err.message };
  }
}

/**
 * gRPC 재초기화 (런타임 환경변수 변경 후)
 */
function reinit() {
  stub  = null;
  _mode = 'mock';
  initGrpc();
  return { mode: _mode };
}

function getMode() { return _mode; }

module.exports = {
  startSession,
  endSession,
  proposeUsageUpdate,
  getChannelStatus,
  initiateDispute,
  accumulateCredit,
  postCompensation,
  ping,
  reinit,
  getMode,
};
