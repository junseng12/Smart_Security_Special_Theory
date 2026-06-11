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
  const holdSeconds = parseInt(process.env.PERUN_HOLD_SECONDS || '120');

  // ★ escrowId는 백엔드에서 직접 계산 (프론트/백엔드 일치 보장)
  const escrowId = computeEscrowId(dbSession.id);

  logger.info('[Orchestrator] calling go-perun StartSession via gRPC', {
    userAddress, serviceType, depositUsdc, mode: perun.getMode(), escrowId,
  });

  // go-perun gRPC 호출 — 실패 시 escrow-only fallback
  let perunRes;
  try {
    perunRes = await perun.startSession({
      userAddress, serviceId: serviceType, depositUsdc, userWireAddr, holdSeconds,
    });
  } catch (perunErr) {
    // go-perun 펀딩/연결 실패 → escrow-only mock으로 폴백
    logger.warn('[Orchestrator] go-perun startSession 실패 → escrow-only fallback', {
      error: perunErr.message,
    });
    const { v4: uuidv4 } = require('uuid');
    const fallbackChannelId = '0x' + Buffer.from(dbSession.id).toString('hex').slice(0, 64).padEnd(64, '0');
    perunRes = {
      ok: true,
      session_id:   `fallback_${uuidv4().slice(0, 8)}`,
      channel_id:   fallbackChannelId,
      hold_deadline: String(Math.floor(Date.now() / 1000) + holdSeconds),
      state_hash:   '0x' + Buffer.from('fallback').toString('hex').padEnd(64, '0'),
      _fallback:    true,
    };
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
 * 세션 종료 → go-perun EndSession → 에스크로 컨트랙트 settleAndRelease
 *
 * 흐름:
 *  1) DB에서 charged_usdc 읽어 chargedUsdc 확정 (go-perun 인메모리 폴백)
 *  2) go-perun EndSession gRPC 호출 (오프체인 채널 정산)
 *  3) 에스크로 컨트랙트 settleAndRelease 호출 (온체인 환불 실행) ★
 *  4) DB 정산 기록
 */
async function endSessionAndSettle({ sessionId, channelId, userAddress, userFinalSig = '', fareUsdc, adjustment }) {
  // ── 1. chargedUsdc 확정 ─────────────────────────────────────────────────────
  let chargedUsdc = fareUsdc || '0';
  try {
    const db = require('./db');
    const result = await db.getPool().query(
      'SELECT charged_usdc FROM sessions WHERE id = $1', [sessionId]
    );
    if (result.rows[0]?.charged_usdc) {
      chargedUsdc = String(result.rows[0].charged_usdc);
    }
  } catch { /* DB 조회 실패 시 fareUsdc 사용 */ }

  await sessionMgr.endSession(sessionId).catch(() => {});
  await sessionMgr.markSettling(sessionId).catch(() => {});

  logger.info('[Orchestrator] endSession with chargedUsdc', {
    sessionId, channelId, chargedUsdc,
  });

  // ── 2. go-perun EndSession (오프체인 채널 종료) ────────────────────────────
  // go-perun endSession — 실패해도 에스크로 정산은 계속 진행
  let perunRes = { fare_usdc: chargedUsdc, refund_usdc: '0', tx_hash: null };
  try {
    const _perunEndRes = await perun.endSession({
      sessionId, channelId, userAddress, userFinalSig, chargedUsdc,
    });
    // go-perun이 반환한 fare_usdc 사용. 없으면 chargedUsdc 폴백
    if (_perunEndRes) perunRes = _perunEndRes;
  } catch (perunEndErr) {
    logger.warn('[Orchestrator] go-perun endSession 실패 → escrow-only 계속', { error: perunEndErr.message });
  }
  const finalFareUsdc = perunRes.fare_usdc || chargedUsdc || '0';

  logger.info('[Orchestrator] go-perun EndSession done', {
    sessionId, fare_usdc: perunRes.fare_usdc, finalFareUsdc,
  });

  // ── 3. 에스크로 컨트랙트 settleAndRelease (온체인 환불) ─────────────────────
  let escrowResult = null;
  try {
    escrowResult = await escrowSvc.settleAndRelease({
      sessionId,
      fareUsdc: finalFareUsdc,
    });
    logger.info('[Orchestrator] escrow settleAndRelease done', {
      sessionId, result: JSON.stringify(escrowResult),
    });
  } catch (escrowErr) {
    logger.error('[Orchestrator] escrow settleAndRelease FAILED', {
      sessionId, error: escrowErr.message,
    });
    throw new Error(`Escrow settle failed: ${escrowErr.message}`);
  }

  // ── 4. DB 정산 기록 ───────────────────────────────────────────────────────
  const refundUsdc = escrowResult?.refundUsdc || perunRes.refund_usdc || '0';
  const txHash     = escrowResult?.txHash     || perunRes.tx_hash     || 'settled_via_perun';

  await settleMgr.recordSettlement({
    sessionId, channelId,
    txHash,
    fareUsdc:   finalFareUsdc,
    refundUsdc,
    userAddress,
  }).catch(() => {});

  logger.info('[Orchestrator] endSessionAndSettle complete', {
    sessionId, finalFareUsdc, refundUsdc, txHash,
  });

  return {
    txHash,
    fareUsdc:   finalFareUsdc,
    refundUsdc,
    escrow:     escrowResult,
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


