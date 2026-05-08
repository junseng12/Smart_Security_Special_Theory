/**
 * Perun Client Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Bridges Node.js ↔ Go Perun node via gRPC (primary) with an HTTP REST
 * fallback. The Go Perun node must be running separately.
 *
 * Proto file: src/proto/perun.proto
 * The gRPC stubs are loaded dynamically at runtime (no code-gen needed).
 */

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const axios = require('axios');
const logger = require('../utils/logger');

const PROTO_PATH = path.join(__dirname, '../proto/perun.proto');

let perunStub = null; // gRPC stub
let useGrpc = false;

// ── gRPC initialisation ──────────────────────────────────────────────────────

function initGrpc() {
  const host = process.env.PERUN_GRPC_HOST;
  const port = process.env.PERUN_GRPC_PORT;

  // Perun Go 노드 주소 미설정 시 → mock 모드 (개발/테스트 전용)
  if (!host || !port || host === 'undefined') {
    logger.info('Perun gRPC host not configured — running in MOCK mode');
    useGrpc = false;
    return;
  }

  try {
    const packageDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDef).perun;
    const target = `${host}:${port}`;
    perunStub = new proto.PerunService(target, grpc.credentials.createInsecure());
    logger.info(`Perun gRPC client targeting ${target}`);
    useGrpc = true;
  } catch (err) {
    logger.warn('gRPC init failed, falling back to mock mode', { error: err.message });
    useGrpc = false;
  }
}

initGrpc();

// ── Mock responses (Perun Go 노드 없이 작동) ─────────────────────────────────
const { v4: uuidv4 } = require('uuid');

function mockOpenChannel({ userAddress, operatorAddress, depositUsdc }) {
  const channelId = `ch_mock_${uuidv4().slice(0,8)}`;
  logger.info('[MOCK] openChannel', { channelId, userAddress, depositUsdc });
  return { channel_id: channelId, deposit_tx: `0xmock_deposit_${channelId}` };
}

function mockProposeUpdate({ channelId, nonce, balances }) {
  const stateHash = `0x${Buffer.from(JSON.stringify({ channelId, nonce, balances })).toString('hex').slice(0,64).padEnd(64,'0')}`;
  const operatorSig = `0xmock_opsig_${nonce}`;
  logger.info('[MOCK] proposeUpdate', { channelId, nonce });
  return { state_hash: stateHash, operator_sig: operatorSig };
}

function mockSettleChannel({ channelId }) {
  const txHash = `0xmock_settle_${channelId.slice(-8)}_${Date.now()}`;
  logger.info('[MOCK] settleChannel', { channelId, txHash });
  return { tx_hash: txHash };
}

// ── Helper: wrap gRPC call in a Promise ────────────────────────────────────

function grpcCall(method, request) {
  return new Promise((resolve, reject) => {
    if (!perunStub) return reject(new Error('gRPC stub not initialised'));
    perunStub[method](request, (err, response) => {
      if (err) return reject(err);
      resolve(response);
    });
  });
}

// ── Helper: REST fallback ────────────────────────────────────────────────────

async function restCall(endpoint, body) {
  const url = `${process.env.PERUN_REST_FALLBACK_URL}${endpoint}`;
  const response = await axios.post(url, body, { timeout: 10_000 });
  return response.data;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Open a new Perun state channel.
 * @param {{ userAddress: string, operatorAddress: string, depositUsdc: string }} params
 * @returns {{ channelId: string, initialState: object }}
 */
async function openChannel(params) {
  logger.debug('perunClient.openChannel', params);
  if (useGrpc) {
    return grpcCall('OpenChannel', {
      user_address: params.userAddress,
      operator_address: params.operatorAddress,
      deposit_usdc: params.depositUsdc,
    });
  }
  if (!process.env.PERUN_REST_FALLBACK_URL) return mockOpenChannel(params);
  return restCall('/channels/open', params);
}

/**
 * Propose an off-chain state update.
 * @param {{ channelId: string, nonce: number, balances: { user: string, operator: string } }} params
 * @returns {{ stateHash: string, operatorSig: string }}
 */
async function proposeUpdate(params) {
  logger.debug('perunClient.proposeUpdate', params);
  if (useGrpc) {
    return grpcCall('ProposeUpdate', {
      channel_id: params.channelId,
      nonce: params.nonce,
      balance_user: params.balances.user,
      balance_operator: params.balances.operator,
    });
  }
  if (!process.env.PERUN_REST_FALLBACK_URL) return mockProposeUpdate(params);
  return restCall('/channels/update', params);
}

/**
 * Finalise the channel and submit settlement TX on-chain.
 * @param {{ channelId: string, finalState: object }} params
 * @returns {{ txHash: string }}
 */
async function settleChannel(params) {
  logger.debug('perunClient.settleChannel', params);
  if (useGrpc) {
    return grpcCall('SettleChannel', {
      channel_id: params.channelId,
      final_state: JSON.stringify(params.finalState),
    });
  }
  if (!process.env.PERUN_REST_FALLBACK_URL) return mockSettleChannel(params);
  return restCall('/channels/settle', params);
}

/**
 * Trigger a dispute with the latest signed state.
 * @param {{ channelId: string, latestState: object }} params
 */
async function disputeChannel(params) {
  logger.debug('perunClient.disputeChannel', params);
  if (useGrpc) {
    return grpcCall('DisputeChannel', {
      channel_id: params.channelId,
      latest_state: JSON.stringify(params.latestState),
    });
  }
  return restCall('/channels/dispute', params);
}


/**
 * Perun 노드 연결 상태 확인 (healthcheck용)
 * @returns {{ connected: boolean, mode: string, host: string|null }}
 */
async function pingPerun() {
  if (!useGrpc) {
    return { connected: false, mode: 'mock', host: null };
  }
  try {
    // gRPC deadline 2초로 빠른 ping
    await new Promise((resolve, reject) => {
      const deadline = new Date(Date.now() + 2000);
      perunStub.ListOpenChannels({}, { deadline }, (err, resp) => {
        if (err) reject(err);
        else resolve(resp);
      });
    });
    const host = process.env.PERUN_GRPC_HOST;
    const port = process.env.PERUN_GRPC_PORT;
    return { connected: true, mode: 'grpc', host: `${host}:${port}` };
  } catch (err) {
    logger.warn('Perun ping failed', { error: err.message });
    return { connected: false, mode: 'grpc_unavailable', host: process.env.PERUN_GRPC_HOST, error: err.message };
  }
}

/**
 * gRPC 재연결 시도 (환경변수 변경 후 런타임 재초기화)
 */
function reinitGrpc() {
  perunStub = null;
  useGrpc = false;
  initGrpc();
  return { mode: useGrpc ? 'grpc' : 'mock' };
}

module.exports = {
  openChannel,
  proposeUpdate,
  settleChannel,
  disputeChannel,
  pingPerun,
  reinitGrpc,
};