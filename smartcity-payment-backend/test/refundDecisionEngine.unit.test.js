const { calcRefundFare } = require('../src/services/refundDecisionEngine');

describe('full refund policy', () => {
  test.each([
    'unlock_failure',
    'service_outage',
    'device_malfunction',
    'wrong_amount',
    'double_charge',
    'manual_request',
  ])('%s leaves no fare for the operator', (reason) => {
    expect(calcRefundFare(reason, '1.234567', '3.000000')).toBe('0.000000');
  });
});
