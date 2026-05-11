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
const escrowSvc = require('./escrowPayoutService');

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

  // escrowId: keccak256(utf8(sessionId)) — 프론트 userDeposit calldata와 일치
  const { ethers } = require('ethers');
  const escrowIdBytes = ethers.keccak256(ethers.toUtf8Bytes(newSession.id));

  // holdDeadline: 백엔드 ESCROW_HOLD_SECONDS 기준 (프론트와 동기화)
  const holdSeconds  = parseInt(process.env.ESCROW_HOLD_SECONDS || '3600');
  const holdDeadline = Math.floor(Date.now() / 1000) + holdSeconds;

  return {
    sessionId:    newSession.id,
    channelId,
    depositTx,
    initialState: state,
    escrowId:     escrowIdBytes,      // ★ 프론트 userDeposit calldata용
    holdDeadline,                     // ★ unix timestamp (초) — 프론트와 백엔드 동기화
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
    await session.endSession(sessionId, { forced: true });
    throw new Error('Channel balance exhausted. Session force-closed.');
  }

  // 3. ★ 핵심: 채널 상태 업데이트 (user잔액 감소, operator잔액 증가)
  //    Perun off-chain update: balances.user -= fare, balances.operator += fare
  //    mock 모드에서는 서명 검증을 bypass (userSig='0xmock_...')
  let updatedState = null;
  try {
    updatedState = await channelMgr.updateChannel({
      channelId,
      chargeUsdc: fare.fareUsdc,
      userSig:    '0xmock_charge_sig',   // demo: 실서비스에선 프론트 서명
      userAddress,
    });
  } catch (updateErr) {
    // 서명 검증 실패 시 → Redis 직접 업데이트 (mock 모드 대응)
    logger.warn('updateChannel sig failed — applying direct state update', { channelId, error: updateErr.message });
    const redis = require('./redisClient');
    const db    = require('./db');
    const cur   = await redis.getChannelState(channelId);
    if (cur) {
      const curUser = BigInt(cur.balances.user);
      const curOp   = BigInt(cur.balances.operator);
      const newState = {
        ...cur,
        nonce:    cur.nonce + 1,
        balances: {
          user:     (curUser - chargeWei).toString(),
          operator: (curOp + chargeWei).toString(),
        },
        updatedAt: Date.now(),
      };
      await redis.saveChannelState(channelId, newState);
      await db.saveStateHistory(channelId, newState).catch(() => {});
      updatedState = newState;
    }
  }

  // 4. 세션 DB에 요금 기록 (endSession 시 fareUsdc 참조용)
  try {
    const db = require('./db');
    await db.getPool().query(
      'UPDATE sessions SET charged_usdc=$1 WHERE id=$2',
      [fare.fareUsdc, sessionId]
    ).catch(() => {});
    // escrow_locks에도 fare_amount 업데이트
    await db.getPool().query(
      'UPDATE escrow_locks SET fare_amount=$1 WHERE session_id=$2',
      [fare.fareUsdc, sessionId]
    ).catch(() => {});
  } catch {}

  // signatureRequest: 프론트에서 MetaMask 서명할 수 있도록 stateHash 포함
  let signatureRequest = null;
  if (updatedState) {
    const { buildStateMessage } = require('./walletService');
    const stateHash = buildStateMessage(
      channelId,
      updatedState.nonce,
      updatedState.balances.user,
      updatedState.balances.operator
    );
    signatureRequest = {
      stateHash,
      nonce:       updatedState.nonce,
      newBalances: updatedState.balances,
    };
  }

  return {
    fare,
    updatedState,
    signatureRequest,
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
async function endSessionAndSettle({ sessionId, channelId, userAddress, userFinalSig, adjustment, fareUsdc: passedFareUsdc }) {
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

  // 4. 에스크로 V2 정산 — 요금→seller, 잔금→buyer
  let escrowResult = null;
  const canEscrow = process.env.ESCROW_CONTRACT_ADDRESS && process.env.OPERATOR_PRIVATE_KEY;
  if (canEscrow) {
    try {
      // 최종 요금 조회
      const settlement = await settleMgr.getLatestSettlement(sessionId).catch(() => null);
      // settlements 테이블에서 operator_earn_usdc가 요금 (Perun finalState.balances.operator)
      // finalState.balances.operator는 wei 단위 → 소수점 변환
      let fareUsdc = '0';

      // 우선순위 0: 프론트에서 직접 전달한 fareUsdc (charge 응답값)
      if (passedFareUsdc && parseFloat(passedFareUsdc) > 0) {
        fareUsdc = String(passedFareUsdc);
        logger.info('fareUsdc from request body', { sessionId, fareUsdc });
      }
      // 우선순위 1: escrow_locks.fare_amount
      else {
        const escrowLock = await require('./db').getPool().query(
          'SELECT fare_amount FROM escrow_locks WHERE session_id=$1', [sessionId]
        ).then(r => r.rows[0]).catch(() => null);

        if (escrowLock?.fare_amount && parseFloat(escrowLock.fare_amount) > 0) {
          fareUsdc = String(escrowLock.fare_amount);
          logger.info('fareUsdc from escrow_locks', { sessionId, fareUsdc });
        }
        // 우선순위 2: Perun finalState.balances.operator (wei → USDC)
        else if (finalState?.balances?.operator && BigInt(finalState.balances.operator) > 0n) {
          const { ethers } = require('ethers');
          fareUsdc = ethers.formatUnits(BigInt(finalState.balances.operator), 6);
          logger.info('fareUsdc from finalState', { sessionId, fareUsdc });
        }
        // 우선순위 3: settlements
        else if (settlement?.operator_earn_usdc && parseFloat(settlement.operator_earn_usdc) > 0) {
          fareUsdc = String(settlement.operator_earn_usdc);
          logger.info('fareUsdc from settlements', { sessionId, fareUsdc });
        }
      }
      logger.info('Final fareUsdc for settleAndRelease', { sessionId, fareUsdc });

      escrowResult = await escrowSvc.settleAndRelease({
        sessionId,
        channelId,
        fareUsdc,
        holdSeconds: parseInt(process.env.ESCROW_HOLD_SECONDS) || 60,
      });
      logger.info('Escrow V2 settled', { sessionId, ...escrowResult });
    } catch (err) {
      logger.warn('Escrow V2 settle failed (non-fatal)', { sessionId, error: err.message });
    }
  }

  // 5. 세션 Settled 처리
  await session.markSettled(sessionId);

  logger.info('Session settled', { sessionId, channelId, txHash });
  return { txHash, finalState, escrow: escrowResult };
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
