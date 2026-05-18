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
const redis = require('./redisClient');
const { getChannelStateWithFallback } = require('./channelManager');
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

  // holdDeadline: userDeposit TX 서명 시 컨트랙트에 전달되는 값
  // holdDeadline > block.timestamp 조건 충족 필요 (컨트랙트 InvalidHoldDeadline 방지)
  // 세션 종료 후 백엔드가 settleAndRelease 호출하므로 세션 시작 후 충분한 시간 설정
  // ESCROW_HOLD_SECONDS: 세션 시작 기준 (approve → userDeposit → operatorDeposit TX 확정 시간 포함)
  // ESCROW_HOLD_SECONDS: Railway 동기 응답 한계 = 90초
  // 90초 초과 설정 시 백그라운드 setTimeout이 Railway에서 종료됨 → settle 미실행
  // holdDeadline: 컨트랙트의 settleAndRelease 허용 시점
  // - 기본 120초(2분): approve + userDeposit MetaMask 서명 후 세션 종료 시 바로 정산 가능
  // - 환경변수 ESCROW_HOLD_SECONDS로 조정 가능
  const rawHoldSec  = parseInt(process.env.ESCROW_HOLD_SECONDS || '120');
  const holdSeconds = Math.min(Math.max(rawHoldSec, 30), 3600); // 30초~1시간
  const holdDeadline = Math.floor(Date.now() / 1000) + holdSeconds;
  logger.info('holdDeadline set', { holdSeconds, holdDeadline, raw: rawHoldSec });

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

  // 2. 채널 잔액 확인 (Redis → DB fallback)
  const channelState = await getChannelStateWithFallback(channelId);
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
    const db    = require('./db');
    const cur   = await getChannelStateWithFallback(channelId);
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
      await redis.saveChannelState(channelId, newState);  // null-safe (Redis 없으면 skip)
      await db.saveStateHistory(channelId, newState).catch(() => {});
      updatedState = newState;
    }
  }

  // 4. ★ 누적 요금 기록 (덮어쓰기 아닌 += 누적)
  //    Perun: 매 update마다 balances.operator 누적 → 종료 시 finalState로 settle
  //    여기서도 sessions.charged_usdc를 누적합으로 유지
  try {
    const db = require('./db');
    // charged_usdc: 누적 합산 (마지막 값 덮어쓰기 금지)
    await db.getPool().query(
      `UPDATE sessions
       SET charged_usdc = COALESCE(charged_usdc, 0) + $1::NUMERIC
       WHERE id = $2`,
      [fare.fareUsdc, sessionId]
    ).catch(() => {});
    // escrow_locks.fare_amount도 누적
    await db.getPool().query(
      `UPDATE escrow_locks
       SET fare_amount = COALESCE(fare_amount, 0) + $1::NUMERIC
       WHERE session_id = $2`,
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

  // 4. 에스크로 V3 정산 — 요금→operator, 잔금→user
  let escrowResult = null;
  const canEscrow = process.env.ESCROW_CONTRACT_ADDRESS && process.env.OPERATOR_PRIVATE_KEY;
  if (!canEscrow) {
    logger.error('⚠️  ESCROW env 미설정 — 온체인 정산 불가! Railway 환경변수를 확인하세요.', {
      hasContract: !!process.env.ESCROW_CONTRACT_ADDRESS,
      hasPrivKey: !!process.env.OPERATOR_PRIVATE_KEY,
    });
    escrowResult = { skipped: true, reason: 'env_not_configured — Railway에 ESCROW_CONTRACT_ADDRESS, OPERATOR_PRIVATE_KEY 설정 필요' };
  }
  if (canEscrow) {
    try {
      // 최종 요금 조회
      const settlement = await settleMgr.getLatestSettlement(sessionId).catch(() => null);
      // settlements 테이블에서 operator_earn_usdc가 요금 (Perun finalState.balances.operator)
      // finalState.balances.operator는 wei 단위 → 소수점 변환
      let fareUsdc = '0';

      // ★ Perun 원칙: finalState.balances.operator = 누적 charge 합계 (wei)
      //   이것이 진짜 Perun 방식의 최종 요금 — 최우선 사용
      // 우선순위 1: finalState.balances.operator (Perun 채널 최종 상태)
      if (finalState?.balances?.operator && BigInt(finalState.balances.operator) > 0n) {
        const { ethers } = require('ethers');
        fareUsdc = ethers.formatUnits(BigInt(finalState.balances.operator), 6);
        logger.info('fareUsdc from finalState.balances.operator (Perun 누적)', { sessionId, fareUsdc });
      }
      // 우선순위 2: sessions.charged_usdc (누적 합산 — fallback)
      if (!fareUsdc || parseFloat(fareUsdc) === 0) {
        const chargedRow = await require('./db').getPool().query(
          'SELECT charged_usdc FROM sessions WHERE id=$1', [sessionId]
        ).then(r => r.rows[0]).catch(() => null);
        if (chargedRow?.charged_usdc && parseFloat(chargedRow.charged_usdc) > 0) {
          fareUsdc = String(chargedRow.charged_usdc);
          logger.info('fareUsdc from sessions.charged_usdc (누적)', { sessionId, fareUsdc });
        }
      }
      // 우선순위 3: escrow_locks.fare_amount (누적)
      if (!fareUsdc || parseFloat(fareUsdc) === 0) {
        const escrowLock = await require('./db').getPool().query(
          'SELECT fare_amount FROM escrow_locks WHERE session_id=$1', [sessionId]
        ).then(r => r.rows[0]).catch(() => null);
        if (escrowLock?.fare_amount && parseFloat(escrowLock.fare_amount) > 0) {
          fareUsdc = String(escrowLock.fare_amount);
          logger.info('fareUsdc from escrow_locks.fare_amount', { sessionId, fareUsdc });
        }
      }
      // 우선순위 4: 프론트 직접 전달 (종료 시 elapsed 기반 — 마지막 수단)
      if (!fareUsdc || parseFloat(fareUsdc) === 0) {
        if (passedFareUsdc && parseFloat(passedFareUsdc) > 0) {
          fareUsdc = String(passedFareUsdc);
          logger.info('fareUsdc from request body (elapsed 기반 fallback)', { sessionId, fareUsdc });
        }
      }
      // 우선순위 5: settlements
      if (!fareUsdc || parseFloat(fareUsdc) === 0) {
        if (settlement?.operator_earn_usdc && parseFloat(settlement.operator_earn_usdc) > 0) {
          fareUsdc = String(settlement.operator_earn_usdc);
          logger.info('fareUsdc from settlements', { sessionId, fareUsdc });
        }
      }

      logger.info('Final fareUsdc for settleAndRelease', { sessionId, fareUsdc });
      escrowResult = await escrowSvc.settleAndRelease({ sessionId, fareUsdc });
      logger.info('Escrow settled', { sessionId, result: JSON.stringify(escrowResult) });
    } catch (err) {
      logger.error('Escrow settle failed', { sessionId, error: err.message, stack: err.stack?.slice(0,300) });
      escrowResult = { skipped: true, reason: err.message };
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
  const state = await getChannelStateWithFallback(channelId);
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
