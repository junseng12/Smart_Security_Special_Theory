/**
 * FareEngine — DB 없는 순수 계산 로직 (테스트용)
 */

const POLICIES = {
  bicycle:    { type: 'time_based',   ratePerMinute: 0.01, minimumFare: 0.10, cap: 5.0,  freeMinutes: 2,  penaltyLate: 1.0 },
  ev_charging:{ type: 'energy_based', ratePerKwh: 0.25,    minimumFare: 0.50, cap: 20.0, sessionFee: 0.10 },
  parking:    { type: 'time_based',   ratePerMinute: 0.02, minimumFare: 0.20, cap: 10.0, freeMinutes: 10, penaltyOverstay: 2.0 },
};

function calculateFare({ serviceType, usage }) {
  const p = POLICIES[serviceType];
  if (!p) throw new Error(`Unknown service type: ${serviceType}`);

  let fare = 0;
  const adjustments = [];

  if (p.type === 'time_based') {
    const billable = Math.max(0, (usage.durationMinutes || 0) - (p.freeMinutes || 0));
    fare = billable * p.ratePerMinute;

    if (usage.isLate)     { fare += p.penaltyLate || 0; adjustments.push('late_penalty'); }
    if (usage.isOverstay) {
      const h = Math.ceil((usage.overstayMinutes || 0) / 60);
      fare += h * (p.penaltyOverstay || 0);
      adjustments.push('overstay_penalty');
    }
  } else if (p.type === 'energy_based') {
    fare = (usage.energyKwh || 0) * p.ratePerKwh;
    if (p.sessionFee) { fare += p.sessionFee; adjustments.push('session_fee'); }
  }

  if (fare > 0 && fare < p.minimumFare) { adjustments.push('minimum_fare'); fare = p.minimumFare; }
  if (fare > p.cap)                     { adjustments.push('cap');          fare = p.cap; }

  fare = Math.round(fare * 1_000_000) / 1_000_000;

  return { fareUsdc: fare.toFixed(6), adjustments, policy: p };
}

module.exports = { calculateFare };
