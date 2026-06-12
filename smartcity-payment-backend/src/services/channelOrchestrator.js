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
const fareEngine  = require('./fareEngine');
const fareEngine  = require('./fareEngine');

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
    // ① sessions.charged_usdc 누적
    await db.getPool().query(
      `UPDATE sessions SET charged_usdc = COALESCE(charged_usdc, 0) + $1::NUMERIC WHERE id = $2`,
      [res.fare_usdc, sessionId]
    );
    // ② channel_states에 오프체인 서명 상태 기록 (분쟁 증거)
    await db.getPool().query(
      `INSERT INTO channel_states
         (channel_id, session_id, nonce, state_hash, fare_usdc, recorded_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (channel_id, nonce) DO NOTHING`,
      [channelId, sessionId,
       Number(res.new_nonce), res.state_hash, res.fare_usdc]
    ).catch(() => {}); // 테이블 없어도 무시
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
  // ── 1. chargedUsdc 확정 ──────────────────────────────────────────────────────
  // 우선순위: ① DB charged_usdc 누적값 (ProposeUsageUpdate 오프체인 서명 결과)
  //          ② DB started_at 기준 fareEngine 재계산 (폴백)
  //          ③ 클라이언트 전달값 (최후 폴백)
  let chargedUsdc = '0';
  let chargeSource = 'unknown';
  try {
    const db = require('./db');
    const row = await db.getPool().query(
      `SELECT started_at, service_type, deposit_usdc, charged_usdc
         FROM sessions WHERE id = $1`, [sessionId]
    );
    const sess = row.rows[0];
    const depositUsdc = parseFloat(sess?.deposit_usdc || 3.0);

    // ① 오프체인 서명 누적값 (ProposeUsageUpdate가 정상 호출된 경우)
    const dbCharged = parseFloat(sess?.charged_usdc || 0);
    if (dbCharged > 0) {
      chargedUsdc = String(Math.min(dbCharged, depositUsdc).toFixed(6));
      chargeSource = 'db_accumulated';
      logger.info('[Orchestrator] chargedUsdc from DB accumulation (ProposeUsageUpdate)', {
        sessionId, dbCharged, chargedUsdc,
      });

    // ② started_at 기준 fareEngine 재계산 (오프체인 서명이 없거나 0인 경우)
    } else if (sess?.started_at && sess?.service_type) {
      const startMs     = new Date(sess.started_at).getTime();
      const durationMin = (Date.now() - startMs) / 60_000;

      const fareResult = await fareEngine.calculateFare({
        sessionId,
        serviceType: sess.service_type,
        usage: { durationMinutes: durationMin },
      });
      const raw = parseFloat(fareResult.fareUsdc);
      chargedUsdc  = String(Math.min(raw, depositUsdc).toFixed(6));
      chargeSource = 'fareengine_recalc';
      logger.info('[Orchestrator] chargedUsdc recalculated from started_at (fallback)', {
        sessionId, durationMin: durationMin.toFixed(2),
        fareResult: fareResult.fareUsdc, chargedUsdc,
      });

    } else {
      // ③ 최후 폴백 — 클라이언트 전달값
      chargedUsdc  = fareUsdc || '0';
      chargeSource = 'client_fallback';
      logger.warn('[Orchestrator] started_at not found, using fareUsdc from client', { sessionId, fareUsdc });
    }
  } catch (e) {
    chargedUsdc  = fareUsdc || '0';
    chargeSource = 'error_fallback';
    logger.warn('[Orchestrator] fare recalc failed, fallback to fareUsdc', { sessionId, error: e.message });
  }
  logger.info('[Orchestrator] chargeSource determined', { sessionId, chargeSource, chargedUsdc });

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



