const { deriveDisplayStatus } = require('../src/services/displayStatus');

describe('deriveDisplayStatus', () => {
  test.each([
    ['Active', 'FullyFunded', null, null, false, 'ACTIVE'],
    ['Settling', 'FullyFunded', 'SUBMITTED', 'SETTLE', false, 'SETTLING'],
    ['Settling', 'Released', 'CONFIRMED', 'SETTLE', false, 'SETTLING'],
    ['Settled', 'Released', 'CONFIRMED', 'CLAIM', false, 'COMPLETED'],
    ['Settling', 'Released', 'CONFIRMED', 'SETTLE', true, 'COMPLETED'],
    ['Settled', 'Refunded', 'CONFIRMED', 'REFUND', false, 'REFUNDED'],
    ['Settled', 'FullyFunded', 'CONFIRMED', 'SETTLE', false, 'NEEDS_ATTENTION'],
    ['Settling', 'FullyFunded', 'REVERTED', 'SETTLE', false, 'NEEDS_ATTENTION'],
  ])(
    '%s / %s / %s / %s / claimed=%s => %s',
    (sessionStatus, escrowState, txStatus, txAction, settlementClaimed, expected) => {
      expect(deriveDisplayStatus({
        sessionStatus, escrowState, txStatus, txAction, settlementClaimed,
      }))
        .toBe(expected);
    }
  );
});
