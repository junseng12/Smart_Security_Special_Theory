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
  const fareEngine      = require('./fareEngine');

  let res = null;
  let usedFallback = false;

  // go-perun 오프체인 요금 계산 시도
  try {
    res = await perun.proposeUsageUpdate({
      sessionId, channelId, serviceType, durationMinutes, energyKwh,
    });
  } catch (perunErr) {
    // channel not found 등 → fareEngine 폴백으로 요금 계산
    logger.warn('chargeUsage: perun 오류 → fareEngine 폴백', {
      sessionId, channelId, error: perunErr.message
    });
    usedFallback = true;
    const fareResult = await fareEngine.calculateFare({
      sessionId, serviceType, usage: { durationMinutes, energyKwh },
    }).catch(() => ({ fare: 0.01, breakdown: {} }));

    const fare_usdc = String(fareResult.fare ?? 0.01);
    const nonce = Date.now(); // 폴백 nonce
    const state_hash = '0x' + Buffer.from(`${sessionId}:${nonce}`).toString('hex').slice(0, 64).padEnd(64, '0');
    res = { fare_usdc, policy_hash: 'fallback', new_nonce: nonce, state_hash, balance_user: '0' };
  }

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
 *  1) DB에서 charged_usdc 읽어 chargedUsdc 확정 (go-perun 인메모리 폴백)
 *  2) go-perun EndSession gRPC 호출 (오프체인 채널 정산)
 *  3) 에스크로 컨트랙트 settleAndRelease 호출 (온체인 환불 실행) ★
 *  4) DB 정산 기록
 */
async function endSessionAndSettle({ sessionId, channelId, userAddress, userFinalSig = '', fareUsdc, adjustment }) {
  // ── 1. chargedUsdc 확정 ──────────────────────────────────────────────────────
  // 서버의 started_at~현재 시각을 기준으로 최종 요금을 한 번 계산한다.
  // 주기 누적값과 go-perun 반환값은 네트워크/인메모리 상태에 따라 일부 분이
  // 빠질 수 있으므로 에스크로에 전달할 최종 요금의 기준으로 사용하지 않는다.
  let chargedUsdc = '0';
  let chargeSource = 'unknown';
  let depositUsdc = 3.0;
  try {
    const db = require('./db');
    const row = await db.getPool().query(
      `SELECT started_at, service_type, deposit_usdc, charged_usdc
         FROM sessions WHERE id = $1`, [sessionId]
    );
    const sess = row.rows[0];
    if (!sess) throw new Error(`Session not found: ${sessionId}`);
    depositUsdc = parseFloat(sess.deposit_usdc || 3.0);

    if (sess.started_at && sess.service_type) {
      let startMs;
      const rawStart = sess.started_at;
      if (typeof rawStart === 'number') {
        startMs = rawStart > 1e12 ? rawStart : rawStart * 1000;
      } else {
        startMs = new Date(rawStart).getTime();
      }
      if (!Number.isFinite(startMs) || startMs <= 0) throw new Error('invalid started_at');

      const durationMin = Math.max(0, (Date.now() - startMs) / 60_000);
      const fareResult = await fareEngine.calculateFare({
        sessionId,
        serviceType: sess.service_type,
        usage: { durationMinutes: durationMin },
      });
      const rawFare = parseFloat(fareResult.fareUsdc);
      if (!Number.isFinite(rawFare)) throw new Error('fareEngine returned an invalid fare');
      chargedUsdc = Math.min(Math.max(rawFare, 0.01), depositUsdc).toFixed(6);
      chargeSource = 'server_duration';
      logger.info('[Orchestrator] authoritative fare calculated', {
        sessionId,
        durationMin: durationMin.toFixed(4),
        chargedUsdc,
      });
    } else {
      throw new Error('started_at or service_type missing');
    }

    await db.getPool().query(
      'UPDATE sessions SET charged_usdc=$2, updated_at=NOW() WHERE id=$1',
      [sessionId, chargedUsdc]
    );
  } catch (e) {
    const candidates = [fareUsdc, userFinalSig]
      .map(Number)
      .filter(Number.isFinite)
      .filter(v => v >= 0);
    const fallbackFare = candidates.length > 0 ? Math.max(...candidates) : 0.01;
    chargedUsdc = Math.min(Math.max(fallbackFare, 0.01), depositUsdc).toFixed(6);
    chargeSource = 'validated_fallback';
    logger.warn('[Orchestrator] authoritative fare calculation failed', {
      sessionId,
      error: e.message,
      chargedUsdc,
    });
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
  // 에스크로 정산은 서버가 계산한 authoritative fare만 사용한다.
  // go-perun 응답은 채널 처리 결과이며 최종 결제 금액을 덮어쓰지 않는다.
  const finalFareUsdc = chargedUsdc;
  if (perunRes.fare_usdc && perunRes.fare_usdc !== finalFareUsdc) {
    logger.warn('[Orchestrator] go-perun fare mismatch; authoritative fare retained', {
      sessionId,
      authoritativeFare: finalFareUsdc,
      perunFare: perunRes.fare_usdc,
    });
  }

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

  // holdDeadline 전이거나 아직 온체인 최종 확인이 안 된 경우 완료로 기록하지 않는다.
  if (escrowResult?.deferred || !escrowResult?.confirmed) {
    const expectedRefund = Math.max(depositUsdc - parseFloat(finalFareUsdc), 0).toFixed(6);
    return {
      deferred: true,
      status: 'settling',
      fareUsdc: finalFareUsdc,
      refundUsdc: escrowResult?.refundUsdc || expectedRefund,
      escrow: escrowResult,
    };
  }

  // ── 4. DB 정산 기록 ───────────────────────────────────────────────────────
  const refundUsdc = escrowResult?.refundUsdc || perunRes.refund_usdc || '0';
  let txHash       = escrowResult?.txHash || null;
  if (!txHash) {
    const db = require('./db');
    const txRow = await db.getPool().query(
      'SELECT settle_tx FROM escrow_locks WHERE session_id=$1',
      [sessionId]
    ).catch(() => ({ rows: [] }));
    txHash = txRow.rows[0]?.settle_tx || null;
  }

  await settleMgr.recordSettlement({
    sessionId, channelId,
    txHash,
    fareUsdc:   finalFareUsdc,
    refundUsdc,
    userAddress,
    confirmed: true,
  }).catch(() => {});

  logger.info('[Orchestrator] endSessionAndSettle complete', {
    sessionId, finalFareUsdc, refundUsdc, txHash,
  });

  return {
    txHash,
    fareUsdc:   finalFareUsdc,
    refundUsdc,
    confirmed: true,
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



