jest.mock('../src/services/channelOrchestrator', () => ({
  getChannelStatus: jest.fn(),
  chargeUsage: jest.fn(),
}));

jest.mock('../src/services/db', () => ({
  getPool: jest.fn(),
}));

jest.mock('../src/services/sessionManager', () => ({
  endSession: jest.fn(),
}));

const orchestrator = require('../src/services/channelOrchestrator');
const db = require('../src/services/db');
const sessionManager = require('../src/services/sessionManager');
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
    const poolQuery = jest.fn().mockResolvedValue({ rows: [{
        id: 'session-1',
        channel_id: 'channel-1',
        user_address: '0xuser',
        service_type: 'bicycle',
        started_at: new Date(start),
        status: 'Active',
        escrow_state: 'FullyFunded',
      }] });
    const lockClient = {
      query: jest.fn().mockResolvedValue({}),
      release: jest.fn(),
    };
    const auditClient = {
      query: jest.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ latest_nonce: 1 }] })
        .mockResolvedValueOnce({}),
      release: jest.fn(),
    };
    db.getPool.mockReturnValue({
      query: poolQuery,
      connect: jest.fn()
        .mockResolvedValueOnce(lockClient)
        .mockResolvedValueOnce(auditClient),
    });
    orchestrator.getChannelStatus.mockResolvedValue({
      nonce: 1,
      balance_op: '0.100000',
      balance_user: '2.900000',
      state_hash: `0x${'ab'.repeat(32)}`,
    });

    const result = await billing.catchUpSession('session-1', start + 67_000);

    expect(orchestrator.chargeUsage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ updated: 0, nonce: 1, targetNonce: 1 });
  });

  test('durably stops billing before flushing the final complete minute', async () => {
    const start = Date.parse('2026-09-15T00:00:00Z');
    const poolQuery = jest.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 'session-1', channel_id: 'channel-1', user_address: '0xuser',
        service_type: 'bicycle', started_at: new Date(start), ended_at: null,
        status: 'Active', escrow_state: 'FullyFunded',
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'session-1', channel_id: 'channel-1', user_address: '0xuser',
        service_type: 'bicycle', started_at: new Date(start),
        ended_at: new Date(start + 67_000), status: 'Ended', escrow_state: 'FullyFunded',
      }] });
    db.getPool.mockReturnValue({ query: poolQuery });
    sessionManager.endSession.mockResolvedValue({ status: 'Ended' });
    orchestrator.getChannelStatus.mockResolvedValue({ nonce: 0 });
    orchestrator.chargeUsage.mockResolvedValue({ updatedState: { nonce: 1 } });

    const result = await billing.stopAndCatchUpSession('session-1', start + 67_000);

    expect(sessionManager.endSession).toHaveBeenCalledWith('session-1');
    expect(orchestrator.chargeUsage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ updated: 1, nonce: 1, targetNonce: 1 });
    expect(sessionManager.endSession.mock.invocationCallOrder[0])
      .toBeLessThan(orchestrator.chargeUsage.mock.invocationCallOrder[0]);
  });

  test('repairs the DB audit when Go-Perun advanced before a DB failure', async () => {
    const start = Date.parse('2026-09-15T00:00:00Z');
    const lockClient = {
      query: jest.fn().mockResolvedValue({}),
      release: jest.fn(),
    };
    const auditClient = {
      query: jest.fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ rows: [{ latest_nonce: 1 }] })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({}),
      release: jest.fn(),
    };
    db.getPool.mockReturnValue({
      query: jest.fn().mockResolvedValue({ rows: [{
        id: 'session-1', channel_id: 'channel-1', user_address: '0xuser',
        service_type: 'bicycle', started_at: new Date(start), status: 'Active',
        escrow_state: 'FullyFunded',
      }] }),
      connect: jest.fn()
        .mockResolvedValueOnce(lockClient)
        .mockResolvedValueOnce(auditClient),
    });
    orchestrator.getChannelStatus.mockResolvedValue({
      nonce: 2,
      balance_op: '0.200000',
      balance_user: '2.800000',
      state_hash: `0x${'cd'.repeat(32)}`,
    });

    const result = await billing.catchUpSession('session-1', start + 120_000);

    expect(result).toMatchObject({ updated: 0, nonce: 2, targetNonce: 2 });
    expect(auditClient.query.mock.calls.some(([sql]) => sql.includes('UPDATE sessions SET charged_usdc'))).toBe(true);
    expect(auditClient.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO channel_states'))).toBe(true);
    expect(auditClient.query.mock.calls.some(([sql]) => sql.includes('UPDATE channels SET latest_nonce'))).toBe(true);
  });
});
