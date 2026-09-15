'use strict';

jest.mock('../src/services/sessionManager', () => ({
  getSession: jest.fn(),
  endSession: jest.fn(),
  markSettling: jest.fn(),
}));

jest.mock('../src/services/perunClient', () => ({
  endSession: jest.fn(),
}));

jest.mock('../src/services/settlementManager', () => ({
  recordSettlement: jest.fn(),
}));

jest.mock('../src/services/escrowPayoutService', () => ({
  settleAndRelease: jest.fn(),
}));

const sessionMgr = require('../src/services/sessionManager');
const perun = require('../src/services/perunClient');
const settleMgr = require('../src/services/settlementManager');
const escrowSvc = require('../src/services/escrowPayoutService');
const orchestrator = require('../src/services/channelOrchestrator');

describe('endSessionAndSettle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('freezes billing before Perun finalization', async () => {
    sessionMgr.getSession.mockResolvedValue({
      status: 'Active',
    });

    sessionMgr.endSession.mockResolvedValue({
      status: 'Ended',
    });

    perun.endSession.mockRejectedValue(
      new Error('Perun unavailable')
    );

    const result = await orchestrator.endSessionAndSettle({
      sessionId: 'session-1',
      channelId: `0x${'12'.repeat(32)}`,
      userAddress: `0x${'34'.repeat(20)}`,
    });

    expect(sessionMgr.endSession)
      .toHaveBeenCalledWith('session-1');

    expect(
      sessionMgr.endSession.mock.invocationCallOrder[0]
    ).toBeLessThan(
      perun.endSession.mock.invocationCallOrder[0]
    );

    expect(result).toMatchObject({
      deferred: true,
      confirmed: false,
      billingStopped: true,
      recoveryPending: true,
      status: 'recovery_pending',
    });

    expect(sessionMgr.markSettling)
      .not.toHaveBeenCalled();

    expect(escrowSvc.settleAndRelease)
      .not.toHaveBeenCalled();
  });

  test('does not reactivate an already Ended session when Perun fails', async () => {
    sessionMgr.getSession.mockResolvedValue({
      status: 'Ended',
    });

    perun.endSession.mockRejectedValue(
      new Error('native proof unavailable')
    );

    const result = await orchestrator.endSessionAndSettle({
      sessionId: 'session-2',
      channelId: `0x${'56'.repeat(32)}`,
      userAddress: `0x${'78'.repeat(20)}`,
    });

    expect(sessionMgr.endSession)
      .not.toHaveBeenCalled();

    expect(result).toMatchObject({
      deferred: true,
      billingStopped: true,
      recoveryPending: true,
      status: 'recovery_pending',
    });

    expect(escrowSvc.settleAndRelease)
      .not.toHaveBeenCalled();
  });

  test('relays valid native Perun proof to escrow settlement', async () => {
    sessionMgr.getSession.mockResolvedValue({
      status: 'Active',
    });

    sessionMgr.endSession.mockResolvedValue({
      status: 'Ended',
    });

    sessionMgr.markSettling.mockResolvedValue({
      status: 'Settling',
    });

    perun.endSession.mockResolvedValue({
      params_abi: Buffer.from('01', 'hex'),
      state_abi: Buffer.from('02', 'hex'),
      signatures: [
        Buffer.alloc(65, 1),
        Buffer.alloc(65, 2),
      ],
    });

    escrowSvc.settleAndRelease.mockResolvedValue({
      confirmed: true,
      deferred: false,
      txHash: `0x${'99'.repeat(32)}`,
      fareUsdc: '0.200000',
      refundUsdc: '2.800000',
    });

    settleMgr.recordSettlement.mockResolvedValue({});

    const result = await orchestrator.endSessionAndSettle({
      sessionId: 'session-3',
      channelId: `0x${'ab'.repeat(32)}`,
      userAddress: `0x${'cd'.repeat(20)}`,
    });

    expect(sessionMgr.endSession)
      .toHaveBeenCalledWith('session-3');

    expect(sessionMgr.markSettling)
      .toHaveBeenCalledWith('session-3');

    expect(escrowSvc.settleAndRelease)
      .toHaveBeenCalledTimes(1);

    const escrowCall =
      escrowSvc.settleAndRelease.mock.calls[0][0];

    expect(escrowCall.sessionId)
      .toBe('session-3');

    expect(escrowCall.proof.paramsABI)
      .toBe('0x01');

    expect(escrowCall.proof.stateABI)
      .toBe('0x02');

    expect(escrowCall.proof.signatures)
      .toHaveLength(2);

    expect(result).toMatchObject({
      confirmed: true,
      billingStopped: true,
      fareUsdc: '0.200000',
      refundUsdc: '2.800000',
    });
  });
});