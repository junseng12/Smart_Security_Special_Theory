/**
 * channelOrchestrator.js — Node.js 세션 라우트 ↔ go-perun 노드 gRPC 오케스트레이터
 */
'use strict';

const { ethers } = require('ethers');
const logger      = require('../utils/logger');
const sessionMgr  = require('./sessionManager');
const perun       = require('./perunClient');
const escrowSvc   = require('./escrowPayoutService');

/**
 * escrowId = keccak256(utf8(sessionId))
 * 백엔드 escrowPayoutService.toEscrowId() 와 동일한 방식
 * 프론트에서도 이 값을 그대로 사용해야 컨트랙트 매핑이 일치함
 */
function computeEscrowId(sessionId) {
  return ethers.keccak256(ethers.toUtf8Bytes(sessionId));
}

async function startSessionAndOpenChannel({
  userAddress,
  serviceType,
  depositUsdc,
  userWireAddr = '',
}) {
  const dbSession = await sessionMgr.startSession({
    userAddress,
    serviceType,
    depositUsdc,
  });

  const holdSeconds = parseInt(
    process.env.PERUN_HOLD_SECONDS || '240'
  );

  const escrowId = computeEscrowId(dbSession.id);

  logger.info(
    '[Orchestrator] calling go-perun StartSession via gRPC',
    {
      userAddress,
      serviceType,
      depositUsdc,
      mode: perun.getMode(),
      escrowId,
    }
  );

  const perunRes = await perun.startSession({
    userAddress,
    serviceId: serviceType,
    depositUsdc,
    userWireAddr,
    holdSeconds,
    externalSessionId: dbSession.id,
    escrowId,
  });

  if (
    perunRes.session_id !== dbSession.id ||
    perunRes.escrow_id?.toLowerCase() !== escrowId.toLowerCase()
  ) {
    throw new Error('Perun canonical session identity mismatch');
  }

  const db = require('./db');
  await db.createChannelRecord({
    id: perunRes.channel_id,
    userAddress,
    operatorAddress: process.env.OPERATOR_ADDRESS,
    depositUsdc,
    openedTx: null,
  });

  await sessionMgr.linkChannel(dbSession.id, perunRes.channel_id);

  logger.info('[Orchestrator] startSessionAndOpenChannel OK', {
    dbSessionId: dbSession.id,
    perunSession: perunRes.session_id,
    channelId: perunRes.channel_id,
    escrowId,
    fallback: !!perunRes._fallback,
  });

  return {
    sessionId: dbSession.id,
    perunSession: perunRes.session_id,
    channelId: perunRes.channel_id,
    escrowId,
    holdDeadline: perunRes.hold_deadline,
    stateHash: perunRes.state_hash,
    fallback: !!perunRes._fallback,
  };
}

async function chargeUsage({
  sessionId,
  channelId,
  userAddress,
  serviceType,
  usage = {},
}) {
  const durationMinutes = usage.durationMinutes ?? 1;
  const energyKwh = usage.energyKwh ?? 0;

  const usedFallback = false;

  const res = await perun.proposeUsageUpdate({
    sessionId,
    channelId,
    serviceType,
    durationMinutes,
    energyKwh,
  });
  const authoritative = await perun.getChannelStatus({ channelId });
  if (Number(authoritative.nonce) < Number(res.new_nonce)) {
    throw new Error('Go-Perun status lagged behind the accepted usage update');
  }
  const cumulativeFare = String(authoritative.balance_op);
  const cumulativeUser = String(authoritative.balance_user);
  if (!/^\d+(\.\d{1,6})?$/.test(cumulativeFare) || !/^\d+(\.\d{1,6})?$/.test(cumulativeUser)) {
    throw new Error('Go-Perun returned invalid cumulative balances');
  }

  const db = require('./db');
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    const audit = await client.query(
      'SELECT latest_nonce FROM channels WHERE id=$1 FOR UPDATE',
      [channelId]
    );
    if (!audit.rows[0]) throw new Error(`Channel audit record not found: ${channelId}`);

    if (Number(res.new_nonce) <= Number(audit.rows[0].latest_nonce || 0)) {
      await client.query('COMMIT');
      return {
        fare: { fareUsdc: res.fare_usdc, policyHash: res.policy_hash },
        updatedState: {
          nonce: Number(authoritative.nonce),
          stateHash: authoritative.state_hash || res.state_hash,
          balances: { user: cumulativeUser },
        },
        signatureRequest: {
          stateHash: authoritative.state_hash || res.state_hash,
          nonce: Number(authoritative.nonce),
        },
        fallback: usedFallback,
      };
    }

    const charged = await client.query(
      `UPDATE sessions
       SET charged_usdc = $1::NUMERIC, updated_at=NOW()
       WHERE id = $2
       RETURNING charged_usdc`,
      [cumulativeFare, sessionId]
    );
    if (!charged.rows[0]) throw new Error(`Session not found after Perun update: ${sessionId}`);

    if (!usedFallback) {
      await client.query(
        `INSERT INTO channel_states
           (
             channel_id,
             session_id,
             nonce,
             state_hash,
             fare_usdc,
             recorded_at,
             balance_user,
             balance_operator
           )
         SELECT $1, $2, $3, $4, $5, NOW(), $6, $7
         WHERE NOT EXISTS (
           SELECT 1 FROM channel_states WHERE channel_id=$1 AND nonce=$3
         )`,
        [
          channelId,
          sessionId,
          Number(res.new_nonce),
          authoritative.state_hash || res.state_hash,
          res.fare_usdc,
          cumulativeUser,
          cumulativeFare,
        ]
      );
      await client.query(
        `UPDATE channels
         SET latest_nonce=$2, latest_state=$3::jsonb, updated_at=NOW()
         WHERE id=$1`,
        [channelId, Number(res.new_nonce), JSON.stringify({
          nonce: Number(res.new_nonce),
          stateHash: authoritative.state_hash || res.state_hash,
          fareUsdc: charged.rows[0].charged_usdc,
          balanceUser: cumulativeUser,
        })]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('[Orchestrator] Perun update succeeded but audit persistence failed', {
      sessionId, channelId, nonce: Number(res.new_nonce), error: err.message,
    });
    throw err;
  } finally {
    client.release();
  }

  return {
    fare: {
      fareUsdc: res.fare_usdc,
      policyHash: res.policy_hash,
    },
    updatedState: {
      nonce: Number(res.new_nonce),
      stateHash: authoritative.state_hash || res.state_hash,
      balances: {
        user: cumulativeUser,
      },
    },
    signatureRequest: {
      stateHash: authoritative.state_hash || res.state_hash,
      nonce: Number(res.new_nonce),
    },
    fallback: usedFallback,
  };
}

/**
 * 세션 종료 → go-perun EndSession → SmartCityEscrow settlement
 *
 * 가장 중요한 규칙:
 *
 * 1. 서비스 종료/과금 중단은 Perun 정산보다 먼저 수행한다.
 * 2. 이후 Perun 또는 RPC 장애가 발생해도 세션을 Active로 되돌리지 않는다.
 * 3. native Perun proof가 없으면 임의 요금 정산을 하지 않는다.
 * 4. proof 생성 실패는 recovery_pending으로 반환하여
 *    scheduler의 자동 환불/복구 경로에 맡긴다.
 */
async function endSessionAndSettle({
  sessionId,
  channelId,
  userAddress,
}) {
  const session = await sessionMgr.getSession(sessionId);

  if (!session) {
    throw new Error(`Session ${sessionId} not found`);
  }

  // ─────────────────────────────────────────────────────────────
  // 1. 과금부터 확실히 중단
  // ─────────────────────────────────────────────────────────────
  if (session.status === 'Active') {
    await sessionMgr.endSession(sessionId);

    logger.info(
      '[Orchestrator] billing stopped before Perun finalization',
      {
        sessionId,
        channelId,
      }
    );
  } else if (
    !['Ended', 'Settling'].includes(session.status)
  ) {
    throw new Error(
      `Session ${sessionId} cannot be ended from ${session.status}`
    );
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Native Perun final proof 생성
  // ─────────────────────────────────────────────────────────────
  let perunRes;

  try {
    perunRes = await perun.endSession({
      sessionId,
      channelId,
      userAddress,
    });
  } catch (err) {
    // 중요:
    // 서비스는 이미 Ended 상태이다.
    // Perun 장애 때문에 절대로 Active로 되돌리면 안 된다.
    logger.error(
      '[Orchestrator] Perun finalization failed after billing stopped',
      {
        sessionId,
        channelId,
        error: err.message,
      }
    );

    return {
      deferred: true,
      confirmed: false,
      billingStopped: true,
      recoveryPending: true,
      status: 'recovery_pending',
      message:
        '서비스 이용은 종료되었습니다. Perun 최종 증명 생성 실패로 정산 복구 또는 자동 환불을 대기합니다.',
      error: err.message,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Native proof 그대로 relay
  // ─────────────────────────────────────────────────────────────
  const proof = {
    paramsABI: ethers.hexlify(perunRes.params_abi),
    stateABI: ethers.hexlify(perunRes.state_abi),
    signatures: perunRes.signatures.map(
      (signature) => ethers.hexlify(signature)
    ),
  };

  await sessionMgr.markSettling(sessionId);

  // ─────────────────────────────────────────────────────────────
  // 4. SmartCityEscrow가 native Perun proof 직접 검증
  // ─────────────────────────────────────────────────────────────
  const escrow = await escrowSvc.settleAndRelease({
    sessionId,
    proof,
  });

  if (escrow.deferred || !escrow.confirmed) {
    return {
      ...escrow,
      billingStopped: true,
      status: 'settling',
      escrow,
    };
  }

  return {
    ...escrow,
    billingStopped: true,
    escrow,
  };
}

async function disputeChannel({ channelId }) {
  return perun.initiateDispute({ channelId });
}

async function getChannelStatus({ channelId }) {
  return perun.getChannelStatus({ channelId });
}

module.exports = {
  startSessionAndOpenChannel,
  chargeUsage,
  endSessionAndSettle,
  disputeChannel,
  getChannelStatus,
};
