# SmartCity Payment Backend — 직접 실행 가이드 (Runbook)

> 이 문서는 개발자가 직접 로컬 or 서버에서 실행할 때 사용하는 단계별 실행 가이드입니다.  
> **시나리오별 명령어 + 예상 응답 + 트러블슈팅**까지 포함되어 있습니다.

---

## 목차

1. [환경 준비](#1-환경-준비)
2. [서버 실행](#2-서버-실행)
3. [시나리오 A — 정상 결제 흐름 (킥보드)](#시나리오-a--정상-결제-흐름-킥보드)
4. [시나리오 B — 잔액 부족 → 강제 종료](#시나리오-b--잔액-부족--강제-종료)
5. [시나리오 C — 환불 요청 흐름](#시나리오-c--환불-요청-흐름)
6. [시나리오 D — 온체인 컨트랙트 직접 검증](#시나리오-d--온체인-컨트랙트-직접-검증)
7. [시나리오 E — Perun gRPC 노드 연결 (실제 노드)](#시나리오-e--perun-grpc-노드-연결-실제-노드)
8. [자동화 테스트 실행](#자동화-테스트-실행)
9. [Docker 실행](#docker-실행)
10. [헬스체크 & 모니터링](#헬스체크--모니터링)
11. [트러블슈팅](#트러블슈팅)

---

## 1. 환경 준비

### 필수 조건

```bash
node -v   # v20 이상
npm -v    # v9 이상
```

### 설치

```bash
cd smartcity-payment-backend
npm install
```

### `.env` 파일 설정

```bash
cp .env.example .env   # 없으면 아래 내용으로 직접 생성
```

**필수 환경변수:**

```env
# 블록체인
BASE_RPC_URL=https://sepolia.base.org
OPERATOR_PRIVATE_KEY=<64자리 hex, 0x 없이>
USDC_CONTRACT_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
ESCROW_CONTRACT_ADDRESS=0xf6B7d5c6C7a907D906419125B9dD2EeeCb26De3c

# 데이터베이스 (Supabase)
DATABASE_URL=postgresql://postgres:PASSWORD@HOST:5432/postgres

# Redis (Upstash)
REDIS_URL=rediss://default:PASSWORD@HOST:PORT

# Perun (없으면 mock 모드로 동작)
# PERUN_GRPC_HOST=localhost
# PERUN_GRPC_PORT=8080

# 기타
NODE_ENV=development
PORT=3000
```

> ⚠️ `TREASURY_PRIVATE_KEY` 없어도 OK — 없으면 `OPERATOR_PRIVATE_KEY`를 재사용합니다.

---

## 2. 서버 실행

```bash
# 개발 모드 (로그 상세)
NODE_ENV=development node src/index.js

# 또는 백그라운드
node src/index.js > logs/server.log 2>&1 &
```

**서버 시작 확인:**

```bash
curl http://localhost:3000/health
```

**예상 응답:**

```json
{
  "status": "healthy",
  "checks": {
    "redis": "ok",
    "db": "ok",
    "perun": "mock:mock",
    "perun_detail": { "connected": false, "mode": "mock", "host": null }
  }
}
```

> `perun: "mock:mock"` → Perun 노드 미연결, mock 모드로 정상 동작  
> `perun: "ok"` → 실제 Perun gRPC 노드 연결됨

---

## 시나리오 A — 정상 결제 흐름 (킥보드)

> **목적:** 세션 시작 → 요금 청구 → 사용자 서명 → 세션 종료까지 전체 흐름 확인

### Step 1: 세션 시작 + 채널 오픈

```bash
curl -X POST http://localhost:3000/api/v1/sessions/start \
  -H "Content-Type: application/json" \
  -d '{
    "userAddress": "0x사용자지갑주소",
    "serviceType": "bicycle",
    "depositUsdc": "5.000000"
  }'
```

**예상 응답 (201):**

```json
{
  "ok": true,
  "data": {
    "sessionId": "0e334d7f-...",
    "channelId": "ch_mock_9ba70bb5",
    "depositTx": "0xmock_deposit_...",
    "initialState": {
      "nonce": 0,
      "balances": { "user": "5000000", "operator": "0" }
    }
  }
}
```

> `sessionId`와 `channelId`를 메모해두세요 — 이후 모든 스텝에서 사용합니다.

---

### Step 2: 세션 상태 확인

```bash
SESSION_ID="위에서_받은_sessionId"

curl http://localhost:3000/api/v1/sessions/$SESSION_ID/status
```

**예상 응답:**

```json
{
  "ok": true,
  "data": {
    "sessionId": "...",
    "status": "deposit_complete",
    "channelState": {
      "nonce": 0,
      "balances": { "user": "5000000", "operator": "0" }
    }
  }
}
```

---

### Step 3: 요금 청구 (10분 자전거)

```bash
SESSION_ID="..."
CHANNEL_ID="..."

curl -X POST http://localhost:3000/api/v1/sessions/$SESSION_ID/charge \
  -H "Content-Type: application/json" \
  -d "{
    \"channelId\": \"$CHANNEL_ID\",
    \"userAddress\": \"0x사용자지갑주소\",
    \"serviceType\": \"bicycle\",
    \"usage\": { \"durationMinutes\": 10 }
  }"
```

**예상 응답 (200):**

```json
{
  "ok": true,
  "data": {
    "fare": {
      "fareUsdc": "0.100000",
      "breakdown": { "baseFare": 0.1 },
      "policyId": "policy_bicycle_v1.0"
    },
    "signatureRequest": {
      "requestId": 3,
      "nonce": 1,
      "newBalances": { "user": "4900000", "operator": "100000" },
      "stateHash": "0x9923f640...",
      "operatorSig": "0xe2bb251c..."
    }
  }
}
```

> `stateHash`와 `operatorSig`를 다음 step에서 사용합니다.

---

### Step 4: 사용자 서명 제출

```bash
# 실제 환경에서는 사용자 지갑(MetaMask 등)이 stateHash에 서명
# 테스트용으로는 임의의 서명값 사용 가능

curl -X POST http://localhost:3000/api/v1/sessions/$SESSION_ID/sign \
  -H "Content-Type: application/json" \
  -d "{
    \"channelId\": \"$CHANNEL_ID\",
    \"nonce\": 1,
    \"userSig\": \"0xtest_user_signature_placeholder\"
  }"
```

**예상 응답 (200):**

```json
{
  "ok": true,
  "data": { "message": "Signature recorded", "nonce": 1 }
}
```

---

### Step 5: 세션 종료 + 정산

```bash
curl -X POST http://localhost:3000/api/v1/sessions/$SESSION_ID/settle \
  -H "Content-Type: application/json" \
  -d "{
    \"channelId\": \"$CHANNEL_ID\",
    \"userAddress\": \"0x사용자지갑주소\",
    \"userFinalSig\": \"0xfinal_user_sig\",
    \"adjustment\": 0
  }"
```

**예상 응답 (200):**

```json
{
  "ok": true,
  "data": {
    "txHash": "0xmock_settle_...",
    "sessionId": "...",
    "status": "settled"
  }
}
```

---

## 시나리오 B — 잔액 부족 → 강제 종료

> **목적:** 채널 잔액이 소진됐을 때 자동 강제 종료 처리 확인

```bash
# depositUsdc를 아주 적게 설정 (0.05 USDC)
curl -X POST http://localhost:3000/api/v1/sessions/start \
  -H "Content-Type: application/json" \
  -d '{
    "userAddress": "0x사용자지갑주소",
    "serviceType": "scooter",
    "depositUsdc": "0.050000"
  }'

# 응답에서 SESSION_ID, CHANNEL_ID 저장 후

# 1시간 킥보드 사용 요청 → 잔액 초과 → 강제 종료
curl -X POST http://localhost:3000/api/v1/sessions/$SESSION_ID/charge \
  -H "Content-Type: application/json" \
  -d "{
    \"channelId\": \"$CHANNEL_ID\",
    \"userAddress\": \"0x사용자지갑주소\",
    \"serviceType\": \"scooter\",
    \"usage\": { \"durationMinutes\": 60 }
  }"
```

**예상 응답 (400 또는 200 with forced close):**

```json
{
  "ok": false,
  "error": "Channel balance exhausted. Session force-closed."
}
```

---

## 시나리오 C — 환불 요청 흐름

> **목적:** 센서 장애 등으로 환불 케이스 생성 → 자동 판단 엔진 실행

### Step 1: 환불 케이스 생성

```bash
curl -X POST http://localhost:3000/api/v1/refunds \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "위에서_받은_sessionId",
    "userAddress": "0x사용자지갑주소",
    "requestedUsdc": "3.000000",
    "reason": "센서 장애로 결제 중복 발생",
    "evidence": {
      "sensorLogs": ["error_at_10:32", "duplicate_charge"],
      "deviceId": "scooter_042"
    }
  }'
```

**예상 응답 (201):**

```json
{
  "ok": true,
  "data": {
    "caseId": "case_97043f41",
    "status": "RECEIVED"
  }
}
```

---

### Step 2: 케이스 조회

```bash
CASE_ID="case_97043f41"

curl http://localhost:3000/api/v1/refunds/$CASE_ID
```

---

### Step 3: 자동 판단 실행

```bash
curl -X POST http://localhost:3000/api/v1/refunds/$CASE_ID/evaluate
```

**판단 결과 설명:**

| 결과 | 조건 |
|------|------|
| `APPROVED` | 유효한 fareRecord + evidence 존재 |
| `REJECTED` | fareRecord 없거나 evidence 불충분 |
| `MANUAL_REVIEW` | 금액 크거나 자동 판단 불가 |

---

## 시나리오 D — 온체인 컨트랙트 직접 검증

> **목적:** Base Sepolia에 배포된 SmartCityEscrow 컨트랙트 직접 호출 확인

```bash
node -e "
const { ethers } = require('ethers');
require('dotenv').config();

const ABI = require('./artifacts/SmartCityEscrow.json');
const provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
const contract = new ethers.Contract(process.env.ESCROW_CONTRACT_ADDRESS, ABI.abi, provider);

(async () => {
  const escrowId = ethers.id('test-escrow-001');
  const status = await contract.getEscrowStatus(escrowId);
  console.log('State:', status[0].toString()); // 0=Held, 1=Released, 2=Refunded
  console.log('Amount:', status[1].toString());
  console.log('Buyer:', status[2]);
  
  const chainId = (await provider.getNetwork()).chainId;
  console.log('ChainId:', chainId.toString(), '(Base Sepolia=84532)');
})();
"
```

**컨트랙트 정보:**

```
주소:   0xf6B7d5c6C7a907D906419125B9dD2EeeCb26De3c
네트워크: Base Sepolia (chainId: 84532)
Explorer: https://sepolia.basescan.org/address/0xf6B7d5c6C7a907D906419125B9dD2EeeCb26De3c
```

---

## 시나리오 E — Perun gRPC 노드 연결 (실제 노드)

> **목적:** Mock 모드 → 실제 Perun Go 노드 연결로 전환

### 1. `.env`에 Perun 노드 주소 추가

```env
PERUN_GRPC_HOST=127.0.0.1
PERUN_GRPC_PORT=8080
```

### 2. 런타임 재연결 (서버 재시작 없이)

```bash
curl -X POST http://localhost:3000/health/perun/reinit
```

**예상 응답:**

```json
{ "ok": true, "mode": "grpc" }
```

### 3. 연결 상태 확인

```bash
curl http://localhost:3000/health
```

**Perun 연결 성공 시:**

```json
{
  "checks": {
    "perun": "ok",
    "perun_detail": {
      "connected": true,
      "mode": "grpc",
      "host": "127.0.0.1:8080"
    }
  }
}
```

### 4. Perun 노드 Docker 실행 (이미지 준비됐을 때)

```bash
docker compose --profile perun up perun-node
```

---

## 자동화 테스트 실행

### 시나리오 테스트 (36개 assertion)

```bash
# 서버가 실행 중인 상태에서
node test/scenario.test.js
```

### 통합 테스트

```bash
node test/integration.test.js
```

### E2E 테스트 (PostgreSQL + Redis 실연결)

```bash
node test/e2e.test.js
```

### 단위 테스트 (로컬, 서버 불필요)

```bash
node test/fareEngineLocal.js
node test/refundLocal.js
node test/sessionLocal.js
node test/orchestratorLocal.js
```

---

## Docker 실행

### 기본 실행 (외부 DB 사용 — Supabase + Upstash)

```bash
# .env 파일 준비 후
docker compose up api watchtower
```

### 로컬 DB 포함 (PostgreSQL + Redis 컨테이너 포함)

```bash
docker compose --profile localdb up
```

### Perun 노드 포함 (이미지 준비됐을 때)

```bash
docker compose --profile perun up
```

### 빌드 확인

```bash
docker build -t smartcity-api:test .
docker run --rm --env-file .env -p 3000:3000 smartcity-api:test
```

---

## 헬스체크 & 모니터링

### 헬스체크

```bash
# 전체 상태
curl http://localhost:3000/health

# 자동 polling (5초마다)
watch -n 5 'curl -s http://localhost:3000/health | python3 -m json.tool'
```

### 로그 확인

```bash
# 실시간 로그
tail -f logs/combined.log

# 에러만
tail -f logs/error.log

# 특정 채널 로그 추적
grep "ch_mock_XXXX" logs/combined.log
```

---

## 트러블슈팅

### ❌ `Cannot convert ch_mock_XXX to a BigInt`

**원인:** `walletService.js`의 `channelIdToBytes32()` 미적용 (구버전)  
**해결:** 서버 재시작 후 확인. 여전히 발생하면 `ps aux | grep node`로 구 프로세스 종료.

```bash
pkill -f "node src/index.js"
node src/index.js
```

---

### ❌ `invalid private key` 에러

**원인:** `.env`의 `OPERATOR_PRIVATE_KEY` 형식 오류  
**확인:** `0x` 없이 64자리 hex인지 확인

```bash
echo ${#OPERATOR_PRIVATE_KEY}  # 64여야 함
```

---

### ❌ `14 UNAVAILABLE: Failed to parse DNS address`

**원인:** `PERUN_GRPC_HOST`가 설정됐는데 Perun 노드가 없을 때  
**해결:** `.env`에서 `PERUN_GRPC_HOST`를 주석 처리하면 mock 모드로 전환됨

---

### ❌ `column "outcome" does not exist`

**원인:** DB 스키마 마이그레이션 미완료  
**해결:**

```bash
node scripts/setup-db.js
```

---

### ❌ Redis 연결 실패

**원인:** `REDIS_URL` 형식 오류 또는 Upstash 토큰 만료  
**확인:**

```bash
node -e "require('dotenv').config(); const r = require('./src/services/redisClient'); r.connectRedis().then(() => console.log('OK')).catch(console.error);"
```

---

## 빠른 참조 — curl 원라이너 모음

```bash
# 헬스
curl -s http://localhost:3000/health | python3 -m json.tool

# 세션 시작
curl -s -X POST http://localhost:3000/api/v1/sessions/start \
  -H "Content-Type: application/json" \
  -d '{"userAddress":"0x...","serviceType":"bicycle","depositUsdc":"5.000000"}' \
  | python3 -m json.tool

# 채널 잔액 확인
curl -s http://localhost:3000/api/v1/channels/$CHANNEL_ID | python3 -m json.tool

# 환불 목록 조회
curl -s http://localhost:3000/api/v1/refunds | python3 -m json.tool

# Perun 재연결
curl -s -X POST http://localhost:3000/health/perun/reinit | python3 -m json.tool
```
