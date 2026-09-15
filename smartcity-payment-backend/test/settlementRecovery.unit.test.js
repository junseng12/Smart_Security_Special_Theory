'use strict';

const { recoveryAction } = require('../src/services/settlementRecovery');

describe('settlement recovery action', () => {
  const deadline = '2026-09-15T04:47:56.000Z';

  test('settles only when a native Perun proof exists', () => {
    expect(recoveryAction({ perunProof: { stateABI: '0x01' }, holdDeadline: deadline }))
      .toBe('settle');
  });

  test('waits through the contract force-refund grace period', () => {
    expect(recoveryAction({
      perunProof: null,
      holdDeadline: deadline,
      nowMs: new Date('2026-09-15T05:47:55.000Z').getTime(),
    })).toBe('wait');
  });

  test('forces a full refund after the grace period when proof is missing', () => {
    expect(recoveryAction({
      perunProof: null,
      holdDeadline: deadline,
      nowMs: new Date('2026-09-15T05:47:56.000Z').getTime(),
    })).toBe('refund');
  });
});
