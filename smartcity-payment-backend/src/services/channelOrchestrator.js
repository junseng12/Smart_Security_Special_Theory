/**
 * channelOrchestrator.js — Node.js 세션 라우트 ↔ go-perun 노드 gRPC 오케스트레이터
 */
'use strict';

const { ethers } = require('ethers');
const logger      = require('../utils/logger');
const sessionMgr  = require('./sessionManager');
const perun       = require('./perunClient');
const settleMgr   = require('./settlementManager');
const escrowSvc   = require('./escrowPayoutService');

/**
 * escrowId = keccak256(utf8(sessionId))
 * 백엔드 escrowPayoutService.toEscrowId() 와 동일한 방식
 * 프론트에서도 이 값을 그대로 사용해야 컨트랙트 매핑이 일치함
 */
function computeEscrowId(sessionId) {
  return ethers.keccak256(ethers.toUtf8Bytes(sessionId));
}

async function startSessionAndOpenChannel({ userAddress, serviceType, depositUsdc, userWireAddr = '' }) {
  const dbSession = await sessionMgr.startSession({ userAddress, serviceType, depositUsdc });
  const holdSeconds = parseInt(process.env.PERUN_HOLD_SECONDS || '240'); // [TEST] 4분 — 운영: 86400(24h)

  // ★ escrowId는 백엔드에서 직접 계산 (프론트/백엔드 일치 보장)
  const escrowId = computeEscrowId(dbSession.id);

  logger.info('[Orchestrator] calling go-perun StartSession via gRPC', {
    userAddress, serviceType, depositUsdc, mode: perun.getMode(), escrowId,
  });

  const perunRes = await perun.startSession({
    userAddress, serviceId:serviceType, depositUsdc, userWireAddr, holdSeconds,
    externalSessionId:dbSession.id, escrowId,
  });
  if (perunRes.session_id !== dbSession.id || perunRes.escrow_id?.toLowerCase() !== escrowId.toLowerCase()) {
    throw new Error('Perun canonical session identity mismatch');
  }

  await sessionMgr.linkChannel(dbSession.id, perunRes.channel_id).catch(() => {});

  logger.info('[Orchestrator] startSessionAndOpenChannel OK', {
    dbSessionId: dbSession.id, perunSession: perunRes.session_id,
    channelId: perunRes.channel_id, escrowId, fallback: !!perunRes._fallback,
  });

  return {
    sessionId:    dbSession.id,
    perunSession: perunRes.session_id,
    channelId:    perunRes.channel_id,
    escrowId,
    holdDeadline: perunRes.hold_deadline,
    stateHash:    perunRes.state_hash,
    fallback:     !!perunRes._fallback,
  };
}

async function chargeUsage({ sessionId, channelId, userAddress, serviceType, usage = {} }) {
  const durationMinutes = usage.durationMinutes ?? 1;
  const energyKwh       = usage.energyKwh       ?? 0;
  const fareEngine      = require('./fareEngine');

  const usedFallback = false;
  const res = await perun.proposeUsageUpdate({sessionId,channelId,serviceType,durationMinutes,energyKwh});

  try {
    const db = require('./db');
    // ① sessions.charged_usdc 누적
    await db.getPool().query(
      `UPDATE sessions SET charged_usdc = COALESCE(charged_usdc, 0) + $1::NUMERIC WHERE id = $2`,
      [res.fare_usdc, sessionId]
    );
    if (!usedFallback) {
      // ② channel_states에 오프체인 서명 상태 기록 (분쟁 증거)
      await db.getPool().query(
        `INSERT INTO channel_states
           (channel_id, session_id, nonce, state_hash, fare_usdc, recorded_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (channel_id, nonce) DO NOTHING`,
        [channelId, sessionId,
         Number(res.new_nonce), res.state_hash, res.fare_usdc]
      ).catch(() => {});
    }
  } catch { /* DB 없어도 go-perun 상태에 영향 없음 */ }

  return {
    fare: { fareUsdc: res.fare_usdc, policyHash: res.policy_hash },
    updatedState: {
      nonce:    Number(res.new_nonce),
      stateHash: res.state_hash,
      balances:  { user: res.balance_user },
    },
    signatureRequest: { stateHash: res.state_hash, nonce: Number(res.new_nonce) },
    fallback: usedFallback,
  };
}

/**
 * 세션 종료 → go-perun EndSession → 에스크로 컨트랙트 settleAndRelease
 *
 * 흐름:
 *  1) go-perun EndSession gRPC 호출로 final Perun proof 수령
 *  2) proof bytes/signatures를 그대로 SmartCityEscrow에 relay
 *  3) 컨트랙트가 verifiedFare()로 fare를 추출하고 정산 예약
 *  4) DB는 온체인 검증 결과만 기록
 */
async function endSessionAndSettle({ sessionId, channelId, userAddress }) {
  const perunRes = await perun.endSession({ sessionId, channelId, userAddress });
  // Keep native bytes and signatures intact. Amounts are read from verified on-chain data.
  const proof = { paramsABI:ethers.hexlify(perunRes.params_abi), stateABI:ethers.hexlify(perunRes.state_abi),
    signatures:perunRes.signatures.map(s => ethers.hexlify(s)) };
  await sessionMgr.endSession(sessionId);
  await sessionMgr.markSettling(sessionId);
  const escrow = await escrowSvc.settleAndRelease({sessionId,proof});
  if (escrow.deferred || !escrow.confirmed) return { ...escrow, status:'settling', escrow };
  await settleMgr.recordSettlement({sessionId,channelId,userAddress,txHash:escrow.txHash,
    fareUsdc:escrow.fareUsdc,refundUsdc:escrow.refundUsdc,confirmed:true});
  return {...escrow,escrow};
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



