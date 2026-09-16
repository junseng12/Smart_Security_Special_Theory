# 운영 및 검증 Runbook

## Railway 서비스별 변수

### Go-Perun 서비스

필수:

- `BASE_RPC_URL`: Base Sepolia RPC
- `CHAIN_ID=84532`
- `OPERATOR_PRIVKEY`: Go-Perun 참가자 키
- `ADJUDICATOR_ADDR`: 현재 Perun adjudicator
- `ASSET_HOLDER_ADDR`: 현재 Perun asset holder
- `USDC_TOKEN_ADDR`: Base Sepolia USDC
- `RECEIVER_ADDR`: 두 번째 Perun 참가자 주소
- `ESCROW_CONTRACT_ADDRESS`: 현재 `SmartCityEscrow`
- `PERUN_PERSISTENCE_PATH`: Railway volume 안의 경로, 예: `/data/perun`
- `GRPC_PORT=50051`

`PERUN_PERSISTENCE_PATH`는 활성 채널과 서명 상태를 재시작 뒤 복구하기 위한 Go-Perun 저장소다. 컨트랙트를 새로 배포하는 경로가 아니다.

### Backend 서비스

필수:

- `DATABASE_URL`
- `REDIS_URL`
- `PERUN_GRPC_HOST`: Railway private DNS의 Go 서비스 호스트
- `PERUN_GRPC_PORT=50051`
- `BASE_RPC_URL`
- `CHAIN_ID=84532`
- `ESCROW_CONTRACT_ADDRESS`
- `USDC_CONTRACT_ADDRESS`
- `OPERATOR_ADDRESS`
- `OPERATOR_PRIVATE_KEY`
- `OPERATOR_DEPOSIT_USDC`
- `ALLOWED_ORIGINS`: 프론트 origin

선택:

- `PERUN_HOLD_SECONDS`
- `CHAIN_TX_REVIEW_AFTER_MS`
- `RATE_LIMIT_WINDOW_MS`
- `RATE_LIMIT_MAX`

### Frontend 서비스

- `VITE_PAYMENT_BACKEND_URL`: Backend 공개 URL
- `VITE_ESCROW_CONTRACT_ADDRESS`: Backend와 동일한 escrow 주소

## 로컬 검증

```bash
cd go-perun-node && go test ./...
cd ../smartcity-payment-backend && npm ci && npm test
cd ../smartcontract && npm test
cd ../smartcity-payment-frontend && npm install && npm run build
```

## Railway 외부 E2E

새 세션으로만 검증한다. 이전 세션은 이전 코드와 상태를 포함할 수 있다.

1. Go `/health`와 Backend `/health`가 모두 정상인지 확인한다.
2. 프론트에서 MetaMask로 새 세션을 만들고 USDC를 예치한다.
3. 67초 이상 기다린다. 상태 API의 `offchainUpdateCount` 또는 DB `channels.latest_nonce`가 1 이상인지 확인한다.
4. 종료 버튼을 한 번 누른다. 즉시 추가 과금이 멈추고 상태가 `SETTLING`이어야 한다.
5. `chain_transactions`에 `SETTLE`, `escrow_locks.state='Released'`, `settlements.status='reserved'`가 기록됐는지 확인한다.
6. dispute window 후 `CLAIM`이 confirmed 되고 `sessions.status='Settled'`, `settlements.status='confirmed'`, API `displayStatus='COMPLETED'`인지 확인한다.
7. 사용자와 운영자 USDC 잔액 변화를 fare/refund와 대조한다.

핵심 DB 확인 쿼리:

```sql
SELECT id,status,channel_id,charged_usdc,started_at,ended_at,settled_at
FROM sessions WHERE id = '<session-id>';

SELECT latest_nonce,latest_state FROM channels WHERE id = '<channel-id>';

SELECT nonce,state_hash,fare_usdc,balance_user,balance_operator,recorded_at
FROM channel_states WHERE session_id = '<session-id>' ORDER BY nonce;

SELECT state,fare_amount,claimable_after,settled_at FROM escrow_locks
WHERE session_id = '<session-id>';

SELECT action,status,tx_hash,confirmed_at,last_error FROM chain_transactions
WHERE session_id = '<session-id>' ORDER BY created_at;

SELECT status,user_refund_usdc,operator_earn_usdc,final_state,confirmed_at
FROM settlements WHERE session_id = '<session-id>' ORDER BY created_at;
```

실제 MetaMask 예치 서명은 사용자 지갑 승인이 필요하므로 자동 로컬 테스트만으로 대체할 수 없다.
