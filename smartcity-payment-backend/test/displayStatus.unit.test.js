const { deriveDisplayStatus } = require('../src/services/displayStatus');

describe('deriveDisplayStatus', () => {
  test.each([
    ['Active', 'FullyFunded', null, 'ACTIVE'],
    ['Settling', 'FullyFunded', 'SUBMITTED', 'SETTLING'],
    ['Settled', 'Released', 'CONFIRMED', 'COMPLETED'],
    ['Settled', 'Refunded', 'CONFIRMED', 'REFUNDED'],
    ['Settled', 'FullyFunded', 'CONFIRMED', 'NEEDS_ATTENTION'],
    ['Settling', 'FullyFunded', 'REVERTED', 'NEEDS_ATTENTION'],
  ])(
    '%s / %s / %s => %s',
    (sessionStatus, escrowState, txStatus, expected) => {
      expect(deriveDisplayStatus({ sessionStatus, escrowState, txStatus }))
        .toBe(expected);
    }
  );
});
