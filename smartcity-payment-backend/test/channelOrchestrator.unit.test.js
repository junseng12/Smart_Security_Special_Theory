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
const orchestrator = require('../src/services/channelOrchestrator');

describe('endSessionAndSettle', () => {
  beforeEach(() => jest.clearAllMocks());

  test('freezes billing before a failing Perun call', async () => {
    sessionMgr.getSession.mockResolvedValue({ status: 'Active' });
    sessionMgr.endSession.mockResolvedValue({ status: 'Ended' });
    perun.endSession.mockRejectedValue(new Error('Perun unavailable'));

    await expect(orchestrator.endSessionAndSettle({
      sessionId: 'session-1',
      channelId: `0x${'12'.repeat(32)}`,
      userAddress: `0x${'34'.repeat(20)}`,
    })).rejects.toThrow('Perun unavailable');

    expect(sessionMgr.endSession).toHaveBeenCalledWith('session-1');
    expect(sessionMgr.endSession.mock.invocationCallOrder[0])
      .toBeLessThan(perun.endSession.mock.invocationCallOrder[0]);
    expect(sessionMgr.markSettling).not.toHaveBeenCalled();
  });
});
