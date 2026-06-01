/**
 * channelOrchestrator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Node.js 세션 라우트 ↔ go-perun 노드 gRPC 연결 오케스트레이터
 */

'use strict';

const logger      = require('../utils/logger');
const sessionMgr  = require('./sessionManager');
const perun       = require('./perunClient');
const settleMgr   = require('./settlementManager');
const { isValidAddress } = require('./walletService');

// ── 세션 시작 → go-perun StartSession (채널 오픈 포함) ────────────────────────

async function startSessionAndOpenChannel({ userAddress, serviceType, depositUsdc, userWireAddr = '' }) {
  // 1. DB 세션 생성
  const dbSession = await sessionMgr.startSession({ userAddress, serviceType, depositUsdc });

  // 2. go-perun StartSession gRPC
  const holdSeconds = parseInt(process.env.PERUN_HOLD_SECONDS || '120');

  logger.info('[Orchestrator] calling go-perun StartSession via gRPC', {
    userAddress, serviceType, depositUsdc, mode: perun.getMode(),
  });

  // mock 없음 — gRPC 실패 시 에러 그대로 throw
  const perunRes = await perun.startSession({
    userAddress,
    serviceId:    serviceType,
    depositUsdc,
    userWireAddr,
    holdSeconds,
  });

  // 3. DB 세션에 채널 ID 연결
  await sessionMgr.linkChannel(dbSession.id, perunRes.channel_id).catch(() => {});

  logger.info('[Orchestrator] startSessionAndOpenChannel OK', {
    dbSessionId:  dbSession.id,
    perunSession: perunRes.session_id,
    channelId:    perunRes.channel_id,
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

// ── 사용량 기반 오프체인 요금 청구 ───────────────────────────────────────────

async function chargeUsage({ sessionId, channelId, userAddress, serviceType, usage = {} }) {
  const durationMinutes = usage.durationMinutes ?? 1;
  const energyKwh       = usage.energyKwh       ?? 0;

  const res = await perun.proposeUsageUpdate({
    sessionId,
    channelId,
    serviceType,
    durationMinutes,
    energyKwh,
  });

  // DB 누적 기록 (옵션)
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
      nonce:     Number(res.new_nonce),
      stateHash: res.state_hash,
      balances:  { user: res.balance_user },
    },
    signatureRequest: {
      stateHash: res.state_hash,
      nonce:     Number(res.new_nonce),
    },
  };
}

// ── 세션 종료 → go-perun EndSession ──────────────────────────────────────────

async function endSessionAndSettle({ sessionId, channelId, userAddress, userFinalSig = '', adjustment }) {
  await sessionMgr.endSession(sessionId).catch(() => {});
  await sessionMgr.markSettling(sessionId).catch(() => {});

  const perunRes = await perun.endSession({
    sessionId,
    channelId,
    userAddress,
    userFinalSig,
  });

  await settleMgr.recordSettlement({
    sessionId,
    channelId,
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

// ── 분쟁 등록 ─────────────────────────────────────────────────────────────────

async function disputeChannel({ channelId }) {
  return perun.initiateDispute({ channelId });
}

// ── 채널 상태 조회 ────────────────────────────────────────────────────────────

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
