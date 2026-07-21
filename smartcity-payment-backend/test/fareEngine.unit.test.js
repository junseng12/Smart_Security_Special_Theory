const mockQuery = jest.fn().mockResolvedValue({ rows: [] });

jest.mock('../src/services/db', () => ({
  getPool: () => ({ query: mockQuery }),
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const fareEngine = require('../src/services/fareEngine');

describe('fareEngine final duration calculation', () => {
  beforeEach(() => mockQuery.mockClear());

  test('charges the exact fractional duration for a 2m13s bicycle session', async () => {
    const result = await fareEngine.calculateFare({
      sessionId: 'session-1',
      serviceType: 'bicycle',
      usage: { durationMinutes: 2 + (13 / 60) },
    });

    expect(result.fareUsdc).toBe('0.221667');
  });

  test('applies the one-minute minimum', async () => {
    const result = await fareEngine.calculateFare({
      sessionId: 'session-2',
      serviceType: 'bicycle',
      usage: { durationMinutes: 0.1 },
    });

    expect(result.fareUsdc).toBe('0.010000');
  });
});
