/**
 * channelOrchestrator.js — Node.js 세션 라우트 ↔ go-perun 노드 gRPC 오케스트레이터
 */
'use strict';

const logger      = require('../utils/logger');
const sessionMgr  = require('./sessionManager');
const perun       = require('./perunClient');
const settleMgr   = require('./settlementManager');

async function startSessionAndOpenChannel({ userAddress, serviceType, depositUsdc, userWireAddr = '' }) {
  const dbSession = await sessionMgr.startSession({ userAddress, serviceType, depositUsdc });
  const holdSeconds = parseInt(process.env.PERUN_HOLD_SECONDS || '120');

  logger.info('[Orchestrator] calling go-perun StartSession via gRPC', {
    userAddress, serviceType, depositUsdc, mode: perun.getMode(),
  });

  const perunRes = await perun.startSession({
    userAddress, serviceId: serviceType, depositUsdc, userWireAddr, holdSeconds,
  });

  await sessionMgr.linkChannel(dbSession.id, perunRes.channel_id).catch(() => {});

  logger.info('[Orchestrator] startSessionAndOpenChannel OK', {
    dbSessionId: dbSession.id, perunSession: perunRes.session_id, channelId: perunRes.channel_id,
  });

  return {
    sessionId:    dbSession.id,
    perunSession: perunRes.session_id,
    channelId:    perunRes.channel_id,
    escrowId:     perunRes.escrow_id,
    holdDeadline: perunRes.hold_deadline,
    stateHash:    perunRes.state_hash,
  };
}

async function chargeUsage({ sessionId, channelId, userAddress, serviceType, usage = {} }) {
  const durationMinutes = usage.durationMinutes ?? 1;
  const energyKwh       = usage.energyKwh       ?? 0;

  const res = await perun.proposeUsageUpdate({
    sessionId, channelId, serviceType, durationMinutes, energyKwh,
  });

  try {
    const db = require('./db');
    await db.getPool().query(
      `UPDATE sessions SET charged_usdc = COALESCE(charged_usdc, 0) + $1::NUMERIC WHERE id = $2`,
      [res.fare_usdc, sessionId]
    );
  } catch { /* DB 없어도 go-perun 상태에 영향 없음 */ }

  return {
    fare: { fareUsdc: res.fare_usdc, policyHash: res.policy_hash },
    updatedState: {
      nonce:    Number(res.new_nonce),
      stateHash: res.state_hash,
      balances:  { user: res.balance_user },
    },
    signatureRequest: { stateHash: res.state_hash, nonce: Number(res.new_nonce) },
  };
}

/**
 * 세션 종료 → go-perun EndSession
 * ★ DB에서 charged_usdc를 읽어서 go-perun에 폴백으로 전달
 *   (컨테이너 재시작으로 인메모리 세션이 사라진 경우 대비)
 */
async function endSessionAndSettle({ sessionId, channelId, userAddress, userFinalSig = '', fareUsdc, adjustment }) {
  // DB에서 charged_usdc 읽기 (go-perun 인메모리 폴백용)
  let chargedUsdc = fareUsdc || '0';
  try {
    const db = require('./db');
    const result = await db.getPool().query(
      'SELECT charged_usdc FROM sessions WHERE id = $1', [sessionId]
    );
    if (result.rows[0] && result.rows[0].charged_usdc) {
      chargedUsdc = String(result.rows[0].charged_usdc);
    }
  } catch { /* DB 조회 실패 시 fareUsdc 사용 */ }

  await sessionMgr.endSession(sessionId).catch(() => {});
  await sessionMgr.markSettling(sessionId).catch(() => {});

  logger.info('[Orchestrator] endSession with chargedUsdc fallback', {
    sessionId, channelId, chargedUsdc,
  });

  const perunRes = await perun.endSession({
    sessionId,
    channelId,
    userAddress,
    userFinalSig,
    chargedUsdc,  // ★ go-perun 인메모리 미스 시 폴백
  });

  await settleMgr.recordSettlement({
    sessionId, channelId,
    txHash:     perunRes.tx_hash || 'perun_settled',
    fareUsdc:   perunRes.fare_usdc,
    refundUsdc: perunRes.refund_usdc,
    userAddress,
  }).catch(() => {});

  logger.info('[Orchestrator] endSessionAndSettle OK', {
    sessionId, fareUsdc: perunRes.fare_usdc, refundUsdc: perunRes.refund_usdc,
  });

  return {
    txHash:     perunRes.tx_hash || 'settled_via_perun',
    fareUsdc:   perunRes.fare_usdc,
    refundUsdc: perunRes.refund_usdc,
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
