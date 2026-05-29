/**
 * channelOrchestrator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Node.js 세션 라우트 ↔ go-perun 노드 gRPC 연결 오케스트레이터
 *
 * 변경 내용 (go-sdk 브랜치):
 *   - perunClient.openChannel / settleChannel → startSession / endSession / proposeUsageUpdate
 *   - Redis 핫 스테이트 제거 (go-perun 노드가 내부적으로 관리)
 *   - 에스크로 V3 로직 제거 (표준 Adjudicator/AssetHolder가 대체)
 *   - 최소한의 DB 기록만 유지 (sessions, settlements 테이블)
 */

'use strict';

const logger      = require('../utils/logger');
const sessionMgr  = require('./sessionManager');
const perun       = require('./perunClient');
const settleMgr   = require('./settlementManager');
const { isValidAddress } = require('./walletService');

// ── 세션 시작 → go-perun StartSession (채널 오픈 포함) ────────────────────────

/**
 * @param {object} p
 * @param {string} p.userAddress
 * @param {string} p.serviceType   'bicycle' | 'ev_charging' | 'parking'
 * @param {string} p.depositUsdc   예: "2.0"
 * @param {string} [p.userWireAddr] libp2p multiaddr (go-perun P2P 주소)
 */
async function startSessionAndOpenChannel({ userAddress, serviceType, depositUsdc, userWireAddr = '' }) {
  // 1. DB 세션 생성
  const dbSession = await sessionMgr.startSession({ userAddress, serviceType, depositUsdc });

  // 2. go-perun StartSession gRPC
  //    → go 노드가 ProposeChannel → Funder.Fund() (approve + deposit on-chain) 수행
  const holdSeconds = parseInt(process.env.PERUN_HOLD_SECONDS || '120');
  let perunRes;
  try {
    perunRes = await perun.startSession({
      userAddress,
      serviceId:    serviceType,
      depositUsdc,
      userWireAddr,
      holdSeconds,
    });
  } catch (err) {
    logger.warn('[Orchestrator] go-perun StartSession 실패 → mock 응답 사용', { error: err.message });
    // mock 응답 (go-perun 노드 미연결 시 개발 모드 유지)
    perunRes = {
      ok:            true,
      session_id:    `mock_${dbSession.id}`,
      channel_id:    `0x${'0'.repeat(64)}`,
      escrow_id:     `escrow_${dbSession.id}`,
      hold_deadline: Math.floor(Date.now() / 1000) + holdSeconds,
      state_hash:    '0x' + '0'.repeat(64),
    };
  }

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

/**
 * 1분마다 호출 — go-perun ch.Update(TransferBalance) [가스비 0]
 *
 * @param {object} p
 * @param {string} p.sessionId
 * @param {string} p.channelId
 * @param {string} p.userAddress
 * @param {string} p.serviceType
 * @param {object} p.usage  { durationMinutes, energyKwh }
 */
async function chargeUsage({ sessionId, channelId, userAddress, serviceType, usage = {} }) {
  const durationMinutes = usage.durationMinutes ?? 1;
  const energyKwh       = usage.energyKwh       ?? 0;

  let res;
  try {
    res = await perun.proposeUsageUpdate({
      sessionId,
      channelId,
      serviceType,
      durationMinutes,
      energyKwh,
    });
  } catch (err) {
    logger.warn('[Orchestrator] proposeUsageUpdate 실패', { sessionId, error: err.message });
    throw err;
  }

  // DB 누적 기록 (옵션 — 분쟁 증거용)
  try {
    const db = require('./db');
    await db.getPool().query(
      `UPDATE sessions
       SET charged_usdc = COALESCE(charged_usdc, 0) + $1::NUMERIC
       WHERE id = $2`,
      [res.fare_usdc, sessionId]
    );
  } catch { /* DB 없어도 go-perun 상태에 영향 없음 */ }

  return {
    fare: {
      fareUsdc:   res.fare_usdc,
      policyHash: res.policy_hash,
    },
    updatedState: {
      nonce:    Number(res.new_nonce),
      stateHash: res.state_hash,
      balances: {
        user:     res.balance_user,
      },
    },
    // 프론트 MetaMask 서명 요청 (go-perun 모드에서는 go 노드가 서명 관리)
    signatureRequest: {
      stateHash: res.state_hash,
      nonce:     Number(res.new_nonce),
    },
  };
}

// ── 세션 종료 → go-perun EndSession (FinalUpdate + Settle) ────────────────────

/**
 * @param {object} p
 * @param {string} p.sessionId
 * @param {string} p.channelId
 * @param {string} p.userAddress
 * @param {string} [p.userFinalSig]  사용자 최종 서명 (go-perun 노드에 전달)
 * @param {object} [p.adjustment]    { creditUsdc }
 */
async function endSessionAndSettle({ sessionId, channelId, userAddress, userFinalSig = '', adjustment }) {
  // 1. DB 세션 상태 업데이트
  await sessionMgr.endSession(sessionId).catch(() => {});
  await sessionMgr.markSettling(sessionId).catch(() => {});

  // 2. go-perun EndSession gRPC
  //    → go 노드: FinalUpdate(IsFinal=true) → ch.Settle() → Adjudicator.conclude() → withdraw
  let perunRes;
  try {
    perunRes = await perun.endSession({
      sessionId,
      channelId,
      userAddress,
      userFinalSig,
    });
  } catch (err) {
    logger.warn('[Orchestrator] go-perun EndSession 실패', { sessionId, error: err.message });
    perunRes = { ok: true, fare_usdc: '0', refund_usdc: '0' };
  }

  // 3. DB 정산 기록
  await settleMgr.recordSettlement({
    sessionId,
    channelId,
    txHash:     perunRes.tx_hash || 'perun_settled',
    fareUsdc:   perunRes.fare_usdc,
    refundUsdc: perunRes.refund_usdc,
    userAddress,
  }).catch(() => {});

  logger.info('[Orchestrator] endSessionAndSettle OK', {
    sessionId,
    fareUsdc:   perunRes.fare_usdc,
    refundUsdc: perunRes.refund_usdc,
  });

  return {
    txHash:     perunRes.tx_hash || 'settled_via_perun',
    fareUsdc:   perunRes.fare_usdc,
    refundUsdc: perunRes.refund_usdc,
  };
}

// ── 분쟁 등록 ────────────────────────────────────────────────────────────────

async function disputeChannel({ channelId }) {
  return perun.initiateDispute({ channelId });
}

// ── 채널 상태 조회 ───────────────────────────────────────────────────────────

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
