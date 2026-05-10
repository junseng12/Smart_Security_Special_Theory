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
const escrowSvc = require('./escrowPayoutService');
const { getChannelState } = require('./redisClient');
const { parseUsdc, formatUsdc } = require('./walletService');

// 서비스 제공자 주소 (환경변수 or 기본값)
const SERVICE_PROVIDER_ADDRESS =
  process.env.SERVICE_PROVIDER_ADDRESS || '0x8496Bc5e840BAA1165a1EF13364C355F2A162d6A';

// 에스크로 hold 기간 (데모: 60초, 운영: 86400초)
const ESCROW_HOLD_SECONDS = parseInt(process.env.ESCROW_HOLD_SECONDS || '60', 10);

// ── 세션 시작 → 채널 오픈 ─────────────────────────────────────────────────────
async function startSessionAndOpenChannel({ userAddress, serviceType, depositUsdc, meta = {} }) {
  const newSession = await session.startSession({ userAddress, serviceType, depositUsdc, meta });
  const { channelId, state, depositTx } = await channelMgr.openChannel({ userAddress, depositUsdc });
  await session.linkChannel(newSession.id, channelId);

  logger.info('Session + Channel opened', { sessionId: newSession.id, channelId, depositUsdc });

  return { sessionId: newSession.id, channelId, depositTx, initialState: state };
}

// ── 사용량 기반 요금 청구 ─────────────────────────────────────────────────────
async function chargeUsage({ sessionId, channelId, userAddress, usage, serviceType }) {
  const fare = await fareMgr.calculateFare({ sessionId, serviceType, usage });

  const channelState = await getChannelState(channelId);
  if (!channelState) throw new Error('Channel state not found');

  const userBalanceWei = BigInt(channelState.balances.user);
  const chargeWei = parseUsdc(fare.fareUsdc);

  if (chargeWei > userBalanceWei) {
    logger.warn('Channel balance insufficient — triggering force close', { channelId, sessionId });
    await session.endSession(sessionId, { forced: true });
    throw new Error('Channel balance exhausted. Session force-closed.');
  }

  const sigRequest = await sigMgr.createSignatureRequest({
    channelId, sessionId, chargeUsdc: fare.fareUsdc, userAddress,
  });

  return { fare, signatureRequest: sigRequest };
}

// ── 세션 종료 → 정산 + 에스크로 온체인 처리 ──────────────────────────────────
/**
 * 흐름:
 * 1. 세션/채널 종료 (기존과 동일)
 * 2. 최종 요금 계산 (fareEngine 마지막 기록 사용)
 * 3. 백엔드(운영자 키)가 에스크로 컨트랙트에 요금만큼 createEscrow
 * 4. 즉시 releaseToSeller → 서비스 제공자에게 요금 전송
 * 5. 잔금(예치금 - 요금)은 컨트랙트가 사용자한테 자동 환불
 *    (데모: holdDeadline=60초 후 releaseToSeller 호출)
 */
async function endSessionAndSettle({ sessionId, channelId, userAddress, userFinalSig, adjustment }) {
  // 1. 세션/채널 종료
  await session.endSession(sessionId);
  await session.markSettling(sessionId);

  const { txHash: closeTxHash, finalState } = await channelMgr.closeChannel({
    channelId, userSig: userFinalSig, userAddress, adjustment,
  });

  // 2. 정산 기록 (기존)
  await settleMgr.recordSettlement({
    sessionId, channelId, txHash: closeTxHash, finalState, userAddress,
  });

  // 3. 최종 요금 계산
  const fareRecord = await fareMgr.getLatestFareRecord(sessionId);
  const fareUsdc = fareRecord ? String(fareRecord.final_fare) : '0';
  const fareUsdcNum = parseFloat(fareUsdc);

  let escrowResult = null;

  if (fareUsdcNum > 0 && process.env.ESCROW_CONTRACT_ADDRESS && process.env.OPERATOR_PRIVATE_KEY) {
    try {
      // 4. 운영자 키로 에스크로 컨트랙트에 요금 잠금
      logger.info('Creating on-chain escrow for fare', { sessionId, fareUsdc, serviceProvider: SERVICE_PROVIDER_ADDRESS });

      escrowResult = await escrowSvc.createEscrow({
        sessionId,
        channelId,
        buyerAddress: userAddress,
        sellerAddress: SERVICE_PROVIDER_ADDRESS,
        amountUsdc: fareUsdc,
        holdSeconds: ESCROW_HOLD_SECONDS,
      });

      logger.info('Escrow created', { sessionId, txHash: escrowResult.txHash });

      // 5. holdDeadline 후 자동 releaseToSeller (비동기 백그라운드)
      _scheduleRelease(sessionId, ESCROW_HOLD_SECONDS * 1000).catch(err =>
        logger.error('Auto-release failed', { sessionId, error: err.message })
      );

    } catch (err) {
      // 에스크로 실패해도 세션 정산은 완료 처리 (데모 안정성)
      logger.error('Escrow creation failed (non-fatal)', { sessionId, error: err.message });
    }
  } else {
    logger.info('Skipping on-chain escrow (no fare or env not set)', { sessionId, fareUsdc });
  }

  // 6. Settled 처리
  await session.markSettled(sessionId);

  logger.info('Session settled', { sessionId, channelId, closeTxHash, escrowTxHash: escrowResult?.txHash });

  return {
    txHash: closeTxHash,
    finalState,
    fareUsdc,
    escrow: escrowResult ? {
      txHash: escrowResult.txHash,
      escrowId: escrowResult.escrowId,
      holdDeadline: escrowResult.holdDeadline,
      releaseTarget: SERVICE_PROVIDER_ADDRESS,
    } : null,
  };
}

// ── holdDeadline 후 자동 releaseToSeller ─────────────────────────────────────
async function _scheduleRelease(sessionId, delayMs) {
  await new Promise(r => setTimeout(r, delayMs + 3000)); // +3초 여유
  logger.info('Auto-releasing escrow to seller', { sessionId });
  await escrowSvc.releaseToSeller(sessionId);
  logger.info('Auto-release complete', { sessionId });
}

// ── 예치금 잔액 비율 확인 ─────────────────────────────────────────────────────
async function checkBalanceThreshold(channelId, thresholdPercent = 10) {
  const state = await getChannelState(channelId);
  if (!state) return null;

  const totalWei = BigInt(state.balances.user) + BigInt(state.balances.operator);
  const userWei = BigInt(state.balances.user);
  if (totalWei === 0n) return { warning: false };

  const pct = Number(userWei * 100n / totalWei);
  return {
    warning: pct <= thresholdPercent,
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
