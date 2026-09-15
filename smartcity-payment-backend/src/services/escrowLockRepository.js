'use strict';

async function upsertUserDeposit(queryable, {
  sessionId,
  escrowId,
  channelId,
  userAddress,
  operatorAddress,
  userDeposit,
  operatorDeposit,
  holdDeadline,
  userDepositTx,
  operatorDepositTx = null,
  state,
}) {
  const result = await queryable.query(
    `INSERT INTO escrow_locks
       (session_id, escrow_id_bytes, channel_id, user_address, operator_address,
        user_deposit, operator_deposit, hold_deadline,
        user_deposit_tx, operator_deposit_tx, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9,$10,$11)
     ON CONFLICT (session_id) DO UPDATE SET
       user_deposit        = EXCLUDED.user_deposit,
       operator_deposit    = EXCLUDED.operator_deposit,
       hold_deadline       = EXCLUDED.hold_deadline,
       user_deposit_tx     = COALESCE(EXCLUDED.user_deposit_tx, escrow_locks.user_deposit_tx),
       operator_deposit_tx = COALESCE(EXCLUDED.operator_deposit_tx, escrow_locks.operator_deposit_tx),
       state               = EXCLUDED.state
     RETURNING *`,
    [sessionId, escrowId, channelId, userAddress, operatorAddress,
      userDeposit, operatorDeposit, holdDeadline, userDepositTx, operatorDepositTx, state]
  );
  return result.rows[0];
}

async function ensureOnchainRecord(queryable, {
  sessionId,
  escrowId,
  channelId,
  userAddress,
  operatorAddress,
  userDeposit,
  operatorDeposit,
  fareAmount,
  holdDeadline,
  state,
}) {
  const result = await queryable.query(
    `INSERT INTO escrow_locks
       (session_id, escrow_id_bytes, channel_id, user_address, operator_address,
        user_deposit, operator_deposit, fare_amount, hold_deadline, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9),$10)
     ON CONFLICT (session_id) DO NOTHING
     RETURNING *`,
    [sessionId, escrowId, channelId, userAddress, operatorAddress,
      userDeposit, operatorDeposit, fareAmount, holdDeadline, state]
  );
  return result.rows[0] || null;
}

module.exports = { upsertUserDeposit, ensureOnchainRecord };
