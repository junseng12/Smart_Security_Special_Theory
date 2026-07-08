/**
 * fareUtils.js
 * DB fareUsdc/refundUsdc가 0이거나 없을 때 프론트에서 직접 재계산하는 공통 유틸
 */

const RATE_PER_MIN = 0.1; // 0.1 USDC/분

/**
 * 이용 요금 계산
 * 우선순위: ① DB fareUsdc > 0 → 그대로 / ② started_at+ended_at 기반 재계산
 */
export function calcFare(s) {
  const deposit = parseFloat(s.depositUsdc || 3.0);
  const fare    = parseFloat(s.fareUsdc || 0);
  if (fare > 0 && fare <= deposit) return fare;

  // DB 값이 없거나 0이면 시간 기반 재계산
  const start = s.startedAt || s.started_at;
  const end   = s.endedAt   || s.ended_at;
  if (start && end) {
    const mins = (new Date(end) - new Date(start)) / 60_000;
    if (mins > 0) {
      return Math.min(
        Math.round(mins * RATE_PER_MIN * 1_000_000) / 1_000_000,
        deposit
      );
    }
  }
  return 0;
}

/**
 * 환불 금액 계산
 * 우선순위: ① DB refundUsdc 정상값 → 그대로 / ② deposit - calcFare 재계산
 */
export function calcRefund(s) {
  const deposit = parseFloat(s.depositUsdc || 3.0);
  const refund  = parseFloat(s.refundUsdc || 0);
  // 정상 범위(0 < refund < deposit)면 그대로
  if (refund > 0 && refund < deposit) return refund;
  const fare = calcFare(s);
  return Math.max(0, parseFloat((deposit - fare).toFixed(6)));
}
