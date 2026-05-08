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
let useGrpc = true;

// ── gRPC initialisation ──────────────────────────────────────────────────────

function initGrpc() {
  try {
    const packageDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });
    const proto = grpc.loadPackageDefinition(packageDef).perun;
    const target = `${process.env.PERUN_GRPC_HOST}:${process.env.PERUN_GRPC_PORT}`;
    perunStub = new proto.PerunService(target, grpc.credentials.createInsecure());
    logger.info(`Perun gRPC client targeting ${target}`);
    useGrpc = true;
  } catch (err) {
    logger.warn('gRPC init failed, falling back to REST', { error: err.message });
    useGrpc = false;
  }
}

initGrpc();

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

module.exports = { openChannel, proposeUpdate, settleChannel, disputeChannel };
