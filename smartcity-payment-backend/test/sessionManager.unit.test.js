jest.mock('../src/services/redisClient', () => ({
  getRedis: jest.fn(),
}));

jest.mock('../src/services/db', () => ({
  getPool: jest.fn(),
}));

const { getRedis } = require('../src/services/redisClient');
const { getPool } = require('../src/services/db');
const sessionManager = require('../src/services/sessionManager');

describe('sessionManager durability ordering', () => {
  beforeEach(() => jest.clearAllMocks());

  test('does not publish a new session to Redis when the DB insert fails', async () => {
    const redis = { set: jest.fn(), del: jest.fn() };
    getRedis.mockReturnValue(redis);
    getPool.mockReturnValue({
      query: jest.fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('database unavailable')),
    });

    await expect(sessionManager.startSession({
      userAddress: '0xuser', serviceType: 'bicycle', depositUsdc: '3',
    })).rejects.toThrow('database unavailable');

    expect(redis.set).not.toHaveBeenCalled();
  });

  test('updates Redis only after the Active-to-Ended DB transition succeeds', async () => {
    const callOrder = [];
    const redis = {
      get: jest.fn().mockResolvedValue(JSON.stringify({ id: 'session-1', status: 'Active' })),
      set: jest.fn(async () => { callOrder.push('redis'); }),
      del: jest.fn(),
    };
    const query = jest.fn(async sql => {
      if (sql.startsWith('UPDATE sessions')) callOrder.push('db');
      return { rows: [{ status: 'Ended' }] };
    });
    getRedis.mockReturnValue(redis);
    getPool.mockReturnValue({ query });

    await sessionManager.endSession('session-1');

    expect(callOrder).toEqual(['db', 'redis']);
    expect(query.mock.calls[0][0]).toContain("status = ANY");
    expect(query.mock.calls[0][1].at(-1)).toEqual(['Active']);
  });
});
