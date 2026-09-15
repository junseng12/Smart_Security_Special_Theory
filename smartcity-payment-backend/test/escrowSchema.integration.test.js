'use strict';

const { Client: PgClient } = require('pg');
const { newDb, DataType } = require('pg-mem');
const { runMigrations } = require('../src/services/db');
const { upsertUserDeposit, ensureOnchainRecord } = require('../src/services/escrowLockRepository');

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const connectionConfig = connectionString
  ? { connectionString, ssl: false }
  : process.env.TEST_PGHOST && process.env.PGUSER && process.env.PGPASSWORD && process.env.PGDATABASE
    ? {
        host: process.env.TEST_PGHOST,
        port: Number(process.env.TEST_PGPORT || 5432),
        user: process.env.PGUSER,
        password: process.env.PGPASSWORD,
        database: process.env.PGDATABASE,
        ssl: false,
      }
    : null;
describe('escrow_locks schema compatibility', () => {
  let client;
  let tableSchema;
  const schema = `escrow_schema_test_${Date.now()}_${process.pid}`;

  beforeAll(async () => {
    if (connectionConfig) {
      client = new PgClient(connectionConfig);
      tableSchema = schema;
    } else {
      const memoryDb = newDb({ noAstCoverageCheck: true });
      memoryDb.public.registerFunction({
        name: 'to_timestamp',
        args: [DataType.text],
        returns: DataType.timestamptz,
        implementation: value => new Date(Number(value) * 1000),
      });
      const { Client: MemoryClient } = memoryDb.adapters.createPg();
      client = new MemoryClient();
      tableSchema = 'public';
    }
    await client.connect();
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET LOCAL search_path TO ${schema}`);

    // Reproduce the deployed schema that triggered the missing amount_usdc error.
    await client.query(`
      CREATE TABLE escrow_locks (
        id              SERIAL PRIMARY KEY,
        session_id      TEXT NOT NULL UNIQUE,
        escrow_id_bytes TEXT NOT NULL,
        user_address    TEXT NOT NULL,
        operator_address TEXT NOT NULL,
        user_deposit    NUMERIC DEFAULT 0,
        hold_deadline   TIMESTAMPTZ NOT NULL,
        state           TEXT NOT NULL DEFAULT 'UserDeposited'
      )
    `);

    await runMigrations(client);
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query('ROLLBACK');
    await client.end();
  });

  test('migration supplies every current escrow column without restoring legacy amount_usdc', async () => {
    const { rows } = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema=$1 AND table_name='escrow_locks'`,
      [tableSchema]
    );
    const columns = new Set(rows.map(row => row.column_name));

    expect([...columns]).toEqual(expect.arrayContaining([
      'channel_id', 'case_id', 'user_deposit', 'operator_deposit', 'fare_amount', 'user_deposit_tx',
      'operator_deposit_tx', 'settle_tx', 'claimable_after', 'perun_proof',
      'retry_count', 'last_error',
    ]));
    expect(columns.has('amount_usdc')).toBe(false);
  });

  test('verified deposit can be recorded and retried idempotently', async () => {
    const deposit = {
      sessionId: 'schema-regression-session',
      escrowId: `0x${'12'.repeat(32)}`,
      channelId: `0x${'34'.repeat(32)}`,
      userAddress: `0x${'56'.repeat(20)}`,
      operatorAddress: `0x${'78'.repeat(20)}`,
      userDeposit: '3.000000',
      operatorDeposit: '0.000000',
      holdDeadline: Math.floor(Date.now() / 1000) + 240,
      userDepositTx: `0x${'9a'.repeat(32)}`,
      state: 'UserDeposited',
    };

    await upsertUserDeposit(client, deposit);
    await upsertUserDeposit(client, deposit);

    const { rows } = await client.query(
      `SELECT user_deposit, operator_deposit, user_deposit_tx, state
       FROM escrow_locks WHERE session_id=$1`,
      [deposit.sessionId]
    );
    expect(rows).toHaveLength(1);
    const saved = {
      ...rows[0],
      user_deposit: Number(rows[0].user_deposit),
      operator_deposit: Number(rows[0].operator_deposit),
    };
    expect(saved).toMatchObject({
      user_deposit: 3,
      operator_deposit: 0,
      user_deposit_tx: deposit.userDepositTx,
      state: 'UserDeposited',
    });
  });

  test('a chain-confirmed refund reconstructs a missing escrow row', async () => {
    const recovered = {
      sessionId: 'chain-only-refund-session',
      escrowId: `0x${'ab'.repeat(32)}`,
      channelId: `0x${'cd'.repeat(32)}`,
      userAddress: `0x${'11'.repeat(20)}`,
      operatorAddress: `0x${'22'.repeat(20)}`,
      userDeposit: '3.0',
      operatorDeposit: '0.0',
      fareAmount: '0.0',
      holdDeadline: Math.floor(Date.now() / 1000) - 3600,
      state: 'Refunded',
    };

    await ensureOnchainRecord(client, recovered);
    await ensureOnchainRecord(client, recovered);

    const { rows } = await client.query(
      `SELECT state, channel_id, user_deposit, operator_deposit, fare_amount
       FROM escrow_locks WHERE session_id=$1`,
      [recovered.sessionId]
    );
    expect(rows).toHaveLength(1);
    expect({
      ...rows[0],
      user_deposit: Number(rows[0].user_deposit),
      operator_deposit: Number(rows[0].operator_deposit),
      fare_amount: Number(rows[0].fare_amount),
    }).toMatchObject({
      state: 'Refunded',
      channel_id: recovered.channelId,
      user_deposit: 3,
      operator_deposit: 0,
      fare_amount: 0,
    });
  });
});
