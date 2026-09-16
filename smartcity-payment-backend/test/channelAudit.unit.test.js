jest.mock('../src/services/sessionManager', () => ({
  startSession: jest.fn(),
  linkChannel: jest.fn(),
}));

jest.mock('../src/services/perunClient', () => ({
  getMode: jest.fn(() => 'grpc'),
  startSession: jest.fn(),
  proposeUsageUpdate: jest.fn(),
  getChannelStatus: jest.fn(),
}));

jest.mock('../src/services/settlementManager', () => ({}));
jest.mock('../src/services/escrowPayoutService', () => ({}));
jest.mock('../src/services/db', () => ({
  createChannelRecord: jest.fn(),
  getPool: jest.fn(),
}));

const sessionMgr = require('../src/services/sessionManager');
const perun = require('../src/services/perunClient');
const db = require('../src/services/db');
const orchestrator = require('../src/services/channelOrchestrator');
const { ethers } = require('ethers');

describe('native Perun channel audit persistence', () => {
  beforeEach(() => jest.clearAllMocks());

  test('creates the relational channel record for a new Go-Perun channel', async () => {
    const sessionId = 'session-1';
    const channelId = `0x${'12'.repeat(32)}`;
    const escrowId = ethers.keccak256(ethers.toUtf8Bytes(sessionId));
    sessionMgr.startSession.mockResolvedValue({ id: sessionId });
    sessionMgr.linkChannel.mockResolvedValue({});
    perun.startSession.mockResolvedValue({
      session_id: sessionId,
      channel_id: channelId,
      escrow_id: escrowId,
      hold_deadline: 123,
      state_hash: `0x${'34'.repeat(32)}`,
    });
    db.createChannelRecord.mockResolvedValue({});
    process.env.OPERATOR_ADDRESS = `0x${'56'.repeat(20)}`;

    await orchestrator.startSessionAndOpenChannel({
      userAddress: `0x${'78'.repeat(20)}`,
      serviceType: 'bicycle',
      depositUsdc: '3',
    });

    expect(db.createChannelRecord).toHaveBeenCalledWith(expect.objectContaining({
      id: channelId,
      depositUsdc: '3',
    }));
  });

  test('stores nonce and state hash in the same transaction as charged fare', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rows: [{ latest_nonce: 0 }] })
      .mockResolvedValueOnce({ rows: [{ charged_usdc: '0.100000' }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const client = { query, release: jest.fn() };
    db.getPool.mockReturnValue({ connect: jest.fn().mockResolvedValue(client) });
    perun.proposeUsageUpdate.mockResolvedValue({
      fare_usdc: '0.100000',
      policy_hash: 'policy',
      new_nonce: 1,
      state_hash: `0x${'ab'.repeat(32)}`,
      balance_user: '2.900000',
    });
    perun.getChannelStatus.mockResolvedValue({
      nonce: 1,
      state_hash: `0x${'ab'.repeat(32)}`,
      balance_user: '2.900000',
      balance_op: '0.100000',
    });

    const result = await orchestrator.chargeUsage({
      sessionId: 'session-1',
      channelId: 'channel-1',
      userAddress: '0xuser',
      serviceType: 'bicycle',
      usage: { durationMinutes: 1 },
    });

    expect(result.updatedState.nonce).toBe(1);
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO channel_states'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes('UPDATE channels'))).toBe(true);
    expect(query).toHaveBeenLastCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});
