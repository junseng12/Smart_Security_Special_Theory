/**
 * Channel Orchestrator
 * ─────────────────────────────────────────────────────────────────────────────
 * "언제 open/update/close 호출할지" 워크플로 결정
 *
 * Session → Channel 연결, 예치금 한도 관리, 정산 경로 결정
 */

const logger = require('../utils/logger');
const session = require('./sessionManager');
const channelMgr = require('./channelManager');
const fareMgr = require('./fareEngine');
const sigMgr = require('./signatureManager');
const settleMgr = require('./settlementManager');
const { getChannelState } = require('./redisClient');
const { parseUsdc, formatUsdc } = require('./walletService');

// ── 세션 시작 → 채널 오픈 ─────────────────────────────────────────────────────

/**
 * 세션 시작 + Perun 채널 오픈을 한 번에 처리
 *
 * @param {object} params
 * @param {string} params.userAddress
 * @param {'bicycle'|'ev_charging'|'parking'} params.serviceType
 * @param {string} params.depositUsdc
 * @param {object} [params.meta]
 */
async function startSessionAndOpenChannel({ userAddress, serviceType, depositUsdc, meta = {} }) {
  // 1. 세션 생성
  const newSession = await session.startSession({ userAddress, serviceType, depositUsdc, meta });

  // 2. Perun 채널 오픈
  const { channelId, state, depositTx } = await channelMgr.openChannel({ userAddress, depositUsdc });

  // 3. 세션 ↔ 채널 연결
  await session.linkChannel(newSession.id, channelId);

  logger.info('Session + Channel opened', {
    sessionId: newSession.id, channelId, depositUsdc,
  });

  return {
    sessionId: newSession.id,
    channelId,
    depositTx,
    initialState: state,
  };
}

// ── 사용량 기반 요금 청구 ─────────────────────────────────────────────────────

/**
 * 사용량 데이터를 받아 요금 계산 → 서명 요청 생성
 * (사용자는 프론트에서 서명 후 /channels/:id/sign 으로 제출)
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.channelId
 * @param {string} params.userAddress
 * @param {object} params.usage  - { durationMinutes } or { energyKwh }
 * @param {'bicycle'|'ev_charging'|'parking'} params.serviceType
 */
async function chargeUsage({ sessionId, channelId, userAddress, usage, serviceType }) {
  // 1. 요금 계산
  const fare = await fareMgr.calculateFare({ sessionId, serviceType, usage });

  // 2. 채널 잔액 확인
  const channelState = await getChannelState(channelId);
  if (!channelState) throw new Error('Channel state not found');

  const userBalanceWei = BigInt(channelState.balances.user);
  const chargeWei = parseUsdc(fare.fareUsdc);

  if (chargeWei > userBalanceWei) {
    logger.warn('Channel balance insufficient — triggering force close', { channelId, sessionId });
    // 잔액 소진 → 강제 종료
    await session.endSession(sessionId, { forced: true });
    throw new Error('Channel balance exhausted. Session force-closed.');
  }

  // 3. 서명 요청 생성
  const sigRequest = await sigMgr.createSignatureRequest({
    channelId,
    sessionId,
    chargeUsdc: fare.fareUsdc,
    userAddress,
  });

  return {
    fare,
    signatureRequest: sigRequest,
  };
}

// ── 세션 종료 → 정산 ──────────────────────────────────────────────────────────

/**
 * 세션 종료 + Perun 채널 정산 트리거
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.channelId
 * @param {string} params.userAddress
 * @param {string} params.userFinalSig   - 사용자의 최종 상태 서명
 * @param {object} [params.adjustment]   - 선택적 크레딧 조정 { creditUsdc }
 */
async function endSessionAndSettle({ sessionId, channelId, userAddress, userFinalSig, adjustment }) {
  // 1. 세션 종료
  await session.endSession(sessionId);
  await session.markSettling(sessionId);

  // 2. 채널 종료 + 온체인 정산
  const { txHash, finalState } = await channelMgr.closeChannel({
    channelId,
    userSig: userFinalSig,
    userAddress,
    adjustment,
  });

  // 3. 정산 결과 기록
  await settleMgr.recordSettlement({
    sessionId,
    channelId,
    txHash,
    finalState,
    userAddress,
  });

  // 4. 세션 Settled 처리
  await session.markSettled(sessionId);

  logger.info('Session settled', { sessionId, channelId, txHash });
  return { txHash, finalState };
}

// ── 예치금 잔액 비율 확인 ─────────────────────────────────────────────────────

/**
 * 채널 잔액이 예치금의 일정 % 이하면 경고 반환
 */
async function checkBalanceThreshold(channelId, thresholdPercent = 10) {
  const state = await getChannelState(channelId);
  if (!state) return null;

  const totalWei = BigInt(state.balances.user) + BigInt(state.balances.operator);
  const userWei  = BigInt(state.balances.user);

  if (totalWei === 0n) return { warning: false };

  const pct = Number(userWei * 100n / totalWei);
  const warning = pct <= thresholdPercent;

  return {
    warning,
    userBalanceUsdc: formatUsdc(userWei),
    remainingPercent: pct,
  };
}

module.exports = {
  startSessionAndOpenChannel,
  chargeUsage,
  endSessionAndSettle,
  checkBalanceThreshold,
};
