/**
 * perunClient.js — Node.js ↔ Go Perun 노드 gRPC 브릿지
 */
'use strict';

const path    = require('path');
const grpc    = require('@grpc/grpc-js');
const loader  = require('@grpc/proto-loader');
const logger  = require('../utils/logger');

const PROTO_PATH = path.join(__dirname, '../proto/smartcity.proto');

let stub   = null;
let _mode  = 'mock';

function initGrpc() {
  const host = process.env.PERUN_GRPC_HOST;
  const port = process.env.PERUN_GRPC_PORT || '50051';
  if (!host || host === 'undefined') {
    logger.info('[perunClient] PERUN_GRPC_HOST 미설정 → MOCK 모드');
    _mode = 'mock';
    return;
  }
  try {
    const pkgDef = loader.loadSync(PROTO_PATH, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
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

const { v4: uuidv4 } = require('uuid');

const mock = {
  StartSession(req) {
    const sessionId = `sess_${uuidv4().slice(0,8)}`;
    const channelId = `0x${Buffer.from(sessionId).toString('hex').slice(0,64).padEnd(64,'0')}`;
    return { ok: true, session_id: sessionId, channel_id: channelId,
      escrow_id: `escrow_${sessionId}`, hold_deadline: String(Math.floor(Date.now()/1000)+(req.hold_seconds||240)),
      state_hash: `0x${Buffer.from('init').toString('hex').padEnd(64,'0')}` };
  },
  ProposeUsageUpdate(req) {
    return { ok: true, fare_usdc: '0.01', policy_hash: '0xpolicy', new_nonce: 1,
      state_hash: '0xstatehash', balance_user: String(parseFloat(req.deposit_usdc||'1')-0.01) };
  },
  GetChannelStatus() { return { ok: true, nonce: 1, balance_user: '0.99', balance_op: '0.01' }; },
  InitiateDispute() { return { ok: true }; },
  AccumulateCredit(req) { return { ok: true, total: req.credit_usdc }; },
  PostCompensation() { return { ok: true, tx_hash: '0xmock' }; },
};

function runMock(method, req) {
  if (mock[method]) return Promise.resolve(mock[method](req));
  return Promise.reject(new Error(`Mock not implemented: ${method}`));
}

async function startSession({ userAddress, serviceId, depositUsdc, externalSessionId, escrowId, userWireAddr='', holdSeconds=120 }) {
  if (_mode !== 'grpc') throw new Error('Native Perun node required for state-bound escrow');
  return call('StartSession', { user_address:userAddress, service_id:serviceId, deposit_usdc:depositUsdc,
    external_session_id:externalSessionId, escrow_id:escrowId, user_wire_addr:userWireAddr, hold_seconds:holdSeconds }, 120_000);
}

async function endSession({ sessionId, channelId, userAddress }) {
  if (_mode !== 'grpc') throw new Error('Native signed final state required; mock settlement disabled');
  const res = await call('EndSession', { session_id:sessionId, channel_id:channelId, user_address:userAddress },60_000);
  if (!res.params_abi?.length || !res.state_abi?.length || res.signatures?.length !== 2 || res.signatures.some(s => s.length !== 65)) {
    throw new Error('Incomplete native Perun settlement proof');
  }
  return res;
}

async function proposeUsageUpdate({ sessionId, channelId, serviceType, durationMinutes, energyKwh=0 }) {
  const req = { session_id: sessionId, channel_id: channelId,
    usage_delta: { service_type: serviceType, duration_minutes: durationMinutes, energy_kwh: energyKwh } };
  if (_mode !== 'grpc') throw new Error('Native Perun usage update required');
  return call('ProposeUsageUpdate', req, 10_000);
}

async function getChannelStatus({ channelId }) {
  if (_mode === 'mock') return runMock('GetChannelStatus', { channel_id: channelId });
  return call('GetChannelStatus', { channel_id: channelId });
}

async function initiateDispute({ channelId }) {
  if (_mode === 'mock') return runMock('InitiateDispute', { channel_id: channelId });
  return call('InitiateDispute', { channel_id: channelId }, 30_000);
}

async function accumulateCredit({ channelId, creditUsdc, reason }) {
  if (_mode === 'mock') return runMock('AccumulateCredit', { channel_id: channelId, credit_usdc: creditUsdc, reason });
  return call('AccumulateCredit', { channel_id: channelId, credit_usdc: creditUsdc, reason });
}

async function postCompensation({ userAddress, amountUsdc, reason }) {
  if (_mode === 'mock') return runMock('PostCompensation', {});
  return call('PostCompensation', { user_address: userAddress, amount_usdc: amountUsdc, reason });
}

async function ping() {
  if (_mode === 'mock') return { connected: false, mode: 'mock' };
  try {
    await call('GetChannelStatus', { channel_id: 'ping' }, 2_000);
    return { connected: true, mode: 'grpc' };
  } catch (err) {
    if (err.message?.includes('not found') || err.code === grpc.status.NOT_FOUND) {
      return { connected: true, mode: 'grpc' };
    }
    return { connected: false, mode: 'grpc', error: err.message };
  }
}

function reinit() { stub = null; _mode = 'mock'; initGrpc(); return { mode: _mode }; }
function getMode() { return _mode; }

module.exports = { startSession, endSession, proposeUsageUpdate, getChannelStatus,
  initiateDispute, accumulateCredit, postCompensation, ping, reinit, getMode };


