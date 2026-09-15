jest.mock('../src/services/channelOrchestrator', () => ({
  getChannelStatus: jest.fn(),
  chargeUsage: jest.fn(),
}));

jest.mock('../src/services/db', () => ({
  getPool: jest.fn(),
}));

const orchestrator = require('../src/services/channelOrchestrator');
const db = require('../src/services/db');
const billing = require('../src/services/usageBillingService');

describe('usageBillingService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('counts only complete one-minute periods', () => {
    const start = Date.parse('2026-09-15T00:00:00Z');
    expect(billing.dueUsageUpdates(start, start + 59_999)).toBe(0);
    expect(billing.dueUsageUpdates(start, start + 60_000)).toBe(1);
    expect(billing.dueUsageUpdates(start, start + 179_999)).toBe(2);
  });

  test('creates exactly one missing Perun update after 67 seconds', async () => {
    const start = Date.parse('2026-09-15T00:00:00Z');
    db.getPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [{
        id: 'session-1',
        channel_id: 'channel-1',
        user_address: '0xuser',
        service_type: 'bicycle',
        started_at: new Date(start),
        status: 'Active',
        escrow_state: 'FullyFunded',
      }] }),
    });
    orchestrator.getChannelStatus.mockResolvedValue({ nonce: 0 });
    orchestrator.chargeUsage.mockResolvedValue({ updatedState: { nonce: 1 } });

    const result = await billing.catchUpSession('session-1', start + 67_000);

    expect(orchestrator.chargeUsage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ updated: 1, nonce: 1, targetNonce: 1 });
  });

  test('does not duplicate an update already present in Go-Perun', async () => {
    const start = Date.parse('2026-09-15T00:00:00Z');
    db.getPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [{
        id: 'session-1',
        channel_id: 'channel-1',
        user_address: '0xuser',
        service_type: 'bicycle',
        started_at: new Date(start),
        status: 'Active',
        escrow_state: 'FullyFunded',
      }] }),
    });
    orchestrator.getChannelStatus.mockResolvedValue({ nonce: 1 });

    const result = await billing.catchUpSession('session-1', start + 67_000);

    expect(orchestrator.chargeUsage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, nonce: 1, targetNonce: 1 });
  });
});
