# SmartCity 에스크로 결제 시스템 — AI Agent 인수인계 문서

> 작성일: 2026-06-16  
> 대상: 이 프로젝트를 처음 받는 AI Agent (컨텍스트 없이도 즉시 이어받을 수 있도록 작성)

---

## 1. 프로젝트 목적

스마트시티 환경(자전거, 전동킥보드, 주차장 등 공유 서비스)에서  
**QR 스캔 → 에스크로 예치 → 실시간 오프체인 요금 청구 → 온체인 정산 → 환불**  
전체 흐름을 블록체인 기반으로 구현하는 결제 시스템이다.

핵심 설계 철학:
- **Trust-minimization**: 스마트컨트랙트가 자금을 보관 → 운영자 먹튀 물리적 방지
- **Gas-free UX**: 1분 단위 오프체인 서명(Perun 상태 채널)으로 MetaMask 팝업 없이 실시간 청구
- **투명성**: BaseScan Verified 컨트랙트, 모든 정산 기록 온체인

---

## 2. 저장소 정보

```
GitHub Repo : junseng12/Smart_Security_Special_Theory
Branch      : go-sdk
```

### 폴더 구조

```
/
├── smartcity-payment-backend/   ← 백엔드 (Node.js, Railway 배포)
├── smartcity-payment-frontend/  ← 프론트엔드 (React/Vite, Railway 배포)
├── smartcontract/               ← 컨트랙트 소스 (참고용, 이미 배포 완료)
├── go-perun-node/               ← Go-Perun 오프체인 채널 노드 (Railway)
└── functions/                   ← Base44 serverless 함수 (보조용)
```

**⚠️ 절대 수정 금지 폴더**: `backend/`, `frontend-latest/` (구버전, 삭제됨)  
**실제 서비스 소스**: `smartcity-payment-backend/`, `smartcity-payment-frontend/` 만 사용

---

## 3. 인프라 & 배포

| 서비스 | 플랫폼 | URL |
|--------|--------|-----|
| 백엔드 API | Railway | `https://payment-backend-production.up.railway.app` |
| 프론트엔드 | Railway | (별도 Railway 서비스) |
| Go-Perun 노드 | Railway | `go-perun.railway.internal` (gRPC) |
| DB | Railway PostgreSQL | `DATABASE_URL` 환경변수 |
| Redis | Railway Redis | `REDIS_URL` 환경변수 |
| 블록체인 | Base Sepolia (testnet, chainId 84532) | `https://sepolia.base.org` |

### Railway 환경변수 (백엔드 필수)

```
PORT=3000
NODE_ENV=production
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
BASE_SEPOLIA_RPC=https://sepolia.base.org
OPERATOR_PRIVATE_KEY=0x...          ← Operator 지갑 프라이빗키
ESCROW_CONTRACT_ADDRESS=0xa2642876a2Aa9F19D22a6e69379bbcA10556977f   ← ★ V3.2 신규 주소
USDC_CONTRACT_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
OPERATOR_ADDRESS=0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7
GRPC_PORT=50051
```

---

## 4. 핵심 주소 (절대 변경 금지)

```
스마트컨트랙트 (V3.2, 신규, Verified):
  0xa2642876a2Aa9F19D22a6e69379bbcA10556977f  ← 모든 결제/정산은 이 주소만

구버전 (절대 사용 금지):
  0x454Dd98f154cC4Af7ACB5390113151E2f0e489a1  ← refundToBuyer 없음, Unverified

USDC (Base Sepolia):
  0x036CbD53842c5426634e7929541eC2318f3dCF7e

Operator 지갑:
  0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7
```

---

## 5. 시스템 아키텍처

```
[User - MetaMask 모바일]
        │
        │ QR 스캔
        ▼
[Frontend - React/Vite]
        │
        │ REST API
        ▼
[Backend - Node.js/Express] ──────────── [PostgreSQL DB]
        │                                     │
        │ ethers.js (Operator 지갑)            │ sessions, escrow_locks,
        │                                     │ channel_states, refund_cases
        │ gRPC                                │
        ▼                                     │
[Go-Perun Node]                              │
  (오프체인 채널 관리)                         │
        │
        │ (온체인 분쟁 시)
        ▼
[SmartCityEscrow V3.2 - Base Sepolia]
  0xa2642876a2Aa9F19D22a6e69379bbcA10556977f
        │
        │ ERC-20
        ▼
[USDC Contract - Base Sepolia]
  0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

---

## 6. 정산 흐름 (표준 5단계)

**이 순서를 절대 바꾸지 말 것**

```
Step 1. userDeposit
  - 사용자가 MetaMask로 직접 서명
  - USDC.approve(V3.2, amount) → Contract.userDeposit(escrowId, operator, amount, holdDeadline)
  - 컨트랙트 state: None → UserDeposited
  - 이벤트: UserDeposited

Step 2. operatorDeposit
  - 백엔드가 Operator 지갑으로 자동 실행 (사용자 /deposit API 호출 시 트리거)
  - Contract.operatorDeposit(escrowId, amount)
  - 컨트랙트 state: UserDeposited → FullyFunded
  - 이벤트: OperatorDeposited

Step 3. 오프체인 사용 (Go-Perun)
  - 1분마다 ProposeUsageUpdate (MetaMask 팝업 없음)
  - 누적 요금을 channel_states 테이블에 nonce+stateHash로 기록 (분쟁 증거)
  - POST /api/v1/channels/:id/update

Step 4. settleAndRelease
  - 사용자가 /end API 호출 → 백엔드가 Operator 지갑으로 자동 실행
  - Contract.settleAndRelease(escrowId, fareAmount)
  - holdDeadline 이후에만 실행 가능 (컨트랙트 강제)
  - 컨트랙트 state: FullyFunded → Released
  - 이벤트: SettledAndReleased
  - fare → Operator, refund → User (컨트랙트 자동 전송)

Step 5. (선택) 환불
  - 사용자 환불 신청 → POST /api/v1/refunds (body: {userAddress, sessionId, reason, refundType})
  - 백엔드 자동 심사 → forceRefund 또는 refundToBuyer
  - 컨트랙트 state: → Refunded
```

---

## 7. 스마트컨트랙트 인터페이스 (V3.2)

### EscrowState enum
```
0: None
1: UserDeposited
2: FullyFunded
3: RefundIssue
4: Released
5: Refunded
```

### 핵심 함수

```solidity
// 사용자가 직접 호출 (MetaMask 서명)
userDeposit(bytes32 escrowId, address operator, uint256 amount, uint256 holdDeadline)

// Operator만 호출 가능 (OPERATOR_ROLE)
operatorDeposit(bytes32 escrowId, uint256 amount)
settleAndRelease(bytes32 escrowId, uint256 fareAmount)
forceRefund(bytes32 escrowId)
refundToBuyer(bytes32 escrowId)
registerRefundIssue(bytes32 escrowId, uint8 issueType, string description, bool penalizeOperator)

// 조회
getEscrowStatus(bytes32 escrowId) returns (state, userDeposit, operatorDeposit, fareAmount, user, operator, holdDeadline, isFullyFunded, isDeadlinePassed)
```

### escrowId 계산 방식 (백엔드/프론트 통일)
```javascript
// Node.js (백엔드)
const { keccak256, toUtf8Bytes } = require('ethers');
const escrowId = keccak256(toUtf8Bytes(sessionId));

// Frontend (walletUtils.js)
async function toBytes32Hex(sessionId) {
  const encoder = new TextEncoder();
  const data = encoder.encode(sessionId);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data); // ← SHA-256 사용!
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}
```
**⚠️ 주의**: 백엔드는 keccak256, 프론트는 SHA-256. 현재 이 불일치가 있으나 백엔드가 holdDeadline을 세션 생성 시 저장하고 프론트에 내려주는 방식으로 우회 중.

---

## 8. 백엔드 API 전체 목록

### Health
```
GET  /health                              → 시스템 상태 확인
GET  /health/escrow-env                   → ESCROW_CONTRACT_ADDRESS 환경변수 확인
```

### Sessions (/api/v1/sessions)
```
POST /start                               → 세션 생성
  body: { userAddress, serviceType, depositUsdc }
  response: { sessionId, escrowId, holdDeadline, channelId }

POST /:id/deposit                         → userDeposit TX 기록 + operatorDeposit 자동 실행
  body: { channelId, userAddress, depositUsdc, depositTxHash, serviceStartedAt }
  response: { ok, data: { operatorDeposit: { txHash } } }

POST /:id/end                             → 세션 종료 + 정산
  body: { channelId, userAddress, fareUsdc }
  response: { ok, data: { fareUsdc, refundUsdc, escrow: { settleTx, deferred } } }

GET  /:id/escrow-status                   → DB+온체인 상태 조회
  response: { data: { dbState, onchain: { state, isFullyFunded }, settled, settleTx } }

GET  /:id/status                          → 세션 상태 조회
GET  /                                    → 세션 목록
GET  /:id/stream                          → SSE 실시간 스트림
POST /:id/charge                          → 요금 청구
POST /:id/sign                            → 서명 요청
```

### Channels (/api/v1/channels)
```
POST /open                                → 채널 열기
POST /:id/update                          → 오프체인 ProposeUsageUpdate
  body: { chargeUsdc, userSig, userAddress, nonce?, cumulativeUsdc?, stepIndex? }
POST /:id/close                           → 채널 닫기
POST /:id/refund                          → 채널 환불
GET  /:id                                 → 채널 조회
```

### Refunds (/api/v1/refunds)
```
POST /                                    → 환불 신청
  body: { userAddress, sessionId, reason, refundType, requestedUsdc? }
  reason enum: unlock_failure | sensor_failure | double_charge | service_outage |
               wrong_amount | device_malfunction | device_fault | wrong_charge |
               manual_request | test

POST /:caseId/evaluate                    → 자동 심사
POST /:caseId/approve                     → 승인 (관리자)
POST /:caseId/reject                      → 거절 (관리자)
POST /:caseId/payout                      → 온체인 환불 실행
GET  /:caseId                             → 케이스 조회
GET  /                                    → 환불 목록
```

---

## 9. DB 스키마 (주요 테이블)

```sql
-- 결제 세션
sessions (id UUID, user_address, service_type, status, meta JSONB, created_at)

-- 에스크로 온체인 상태 기록
escrow_locks (
  session_id UUID,
  escrow_id_bytes TEXT,      -- 0x... hex
  channel_id TEXT,
  user_address TEXT,
  operator_address TEXT,
  user_deposit NUMERIC,
  operator_deposit NUMERIC,
  fare_amount NUMERIC,
  user_deposit_tx TEXT,      -- TX hash
  operator_deposit_tx TEXT,
  settle_tx TEXT,
  hold_deadline TIMESTAMPTZ, -- to_timestamp(unix_sec) 으로 저장
  state TEXT,                -- UserDeposited | FullyFunded | Released | Refunded
  settled_at TIMESTAMPTZ
)

-- 오프체인 채널 상태 (분쟁 증거)
channel_states (
  channel_id TEXT,
  session_id UUID,
  nonce INT,
  state_hash TEXT,
  cumulative_usdc NUMERIC,
  user_sig TEXT,
  created_at
)

-- 환불 케이스
refund_cases (
  id UUID,
  session_id UUID,
  user_address TEXT,
  reason TEXT,
  refund_type TEXT,
  requested_usdc NUMERIC,
  status TEXT,               -- pending | approved | rejected | paid
  created_at
)

-- Perun 채널
channels (id TEXT, session_id UUID, state TEXT, balance NUMERIC, ...)
```

---

## 10. 프론트엔드 구성

### 페이지 목록
```
Dashboard.jsx         → 메인 대시보드 (잔액, 최근 내역)
ScanPay.jsx           → QR 스캔 결제 메인 화면 (가장 복잡한 파일, 934L)
TransactionHistory.jsx→ 거래 내역 + 세션ID 복사 기능
RefundCenter.jsx      → 환불 신청 화면
Deposit.jsx           → USDC 입금
Send.jsx              → 전송
Profile.jsx           → 지갑 주소, 잔액 조회
```

### 핵심 유틸 파일
```
src/lib/walletUtils.js   → MetaMask 연동, USDC approve, userDeposit ABI 인코딩
src/components/wallet/   → 공통 컴포넌트
```

### walletUtils.js 핵심 상수
```javascript
USDC_ADDRESS    = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
ESCROW_V3_ADDRESS = "0xa2642876a2Aa9F19D22a6e69379bbcA10556977f"
OPERATOR_ADDRESS = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7"
BACKEND = "https://payment-backend-production.up.railway.app"
```

### ScanPay.jsx 결제 플로우 (상태 머신)
```
stage: "idle"
  → QR 스캔 or 수동 입력
stage: "session_created"
  → POST /sessions/start → escrowId, holdDeadline 수신
stage: "approved"
  → USDC.approve(ESCROW_V3_ADDRESS, amount)  [MetaMask 팝업 1]
stage: "deposited"
  → Contract.userDeposit(escrowId, operator, amount, holdDeadline) [MetaMask 팝업 2]
  → POST /sessions/:id/deposit → operatorDeposit 자동 실행
stage: "active"
  → 1분마다 ProposeUsageUpdate (자동, MetaMask 팝업 없음)
  → 요금 카운터 표시
stage: "ended"
  → POST /sessions/:id/end → settleTx 수신
  → 정산 결과 표시 (fare, refund)
```

---

## 11. 서비스 파일 역할 (백엔드)

```
src/services/
  escrowPayoutService.js  ← 에스크로 핵심 로직
    - recordUserDeposit()    : userDeposit TX 기록
    - operatorDeposit()      : Operator 지갑으로 온체인 예치
    - settleAndPayout()      : settleAndRelease 호출
    - getEscrowContract()    : process.env.ESCROW_CONTRACT_ADDRESS 사용 (env변수)

  channelOrchestrator.js  ← 세션 생명주기 총괄
    - startSession()         : 세션 생성 + holdDeadline 계산
    - endSessionAndSettle()  : 세션 종료 + 정산

  channelManager.js       ← Perun 채널 관리 (gRPC)
  sessionManager.js       ← DB sessions 테이블 CRUD
  settlementManager.js    ← 정산 로직
  refundCaseManager.js    ← 환불 케이스 관리
  refundDecisionEngine.js ← 환불 자동 심사
  watchtower.js           ← 온체인 모니터링 (Released 상태 자동 감지)
  walletService.js        ← Operator 지갑 ethers.js 래퍼
  fareEngine.js           ← 요금 계산 (DB serviceStartedAt 기준)
  db.js                   ← PostgreSQL pool
  redisClient.js          ← Redis 연결
```

---

## 12. 현재 진행 상태 (2026-06-16 기준)

### ✅ 완료된 것
- 신규 컨트랙트 V3.2 배포 + BaseScan Verified
- Railway ESCROW_CONTRACT_ADDRESS = 신규(0xa264) 설정 완료
- userDeposit → operatorDeposit → FullyFunded 온체인 플로우 정상 동작
- settleAndRelease → Released 플로우 정상 동작
- 프론트엔드 walletUtils.js / ScanPay.jsx 신규 주소 동기화 완료
- 백엔드 operatorDeposit 금액 자동 동기화 (DB에서 보정)
- channels.js updateSchema에 nonce/cumulativeUsdc/stepIndex 추가
- refunds.js reason enum에 'test' 추가
- opDepositUsdc 기본값 '3.0' → '0.10' 수정

### ❌ E2E 테스트 미통과 항목
- **TC10: settleAndRelease → Released 온체인 확정**  
  원인: holdDeadline이 아직 안 지난 시점에 Released 체크 → 25초 대기로도 부족  
  해결책: Watchtower가 자동 처리하므로 실제 운영에선 정상 (테스트 타이밍 문제)  
  → Watchtower 확인 로직에 더 긴 대기(60초) 또는 폴링 방식 추가 필요

### 🔧 추가로 개선 가능한 것
1. **holdDeadline 단축 테스트**: 현재 4분(240초) → E2E 테스트용 환경변수로 조절 가능하게
2. **0 USDC API레벨 거부**: 현재 세션 생성 후 컨트랙트에서 revert → API 레벨에서 사전 차단 가능
3. **escrowId 계산 통일**: 백엔드(keccak256) ↔ 프론트(SHA-256) 불일치 → 장기적으로 통일 필요
4. **Watchtower claimSettlement**: Released 후 24시간 대기 → 자동 claimSettlement 구현 필요

---

## 13. 최근 커밋 내역 (go-sdk)

```
b1f463d8  2026-06-16  fix: operatorDeposit 금액 DB에서 자동 동기화
fd3b125f  2026-06-16  fix: refunds reason enum 'test' 추가
e5fa8ca6  2026-06-16  fix: channels updateSchema nonce/cumulativeUsdc 추가
0bf6fdb0  2026-06-16  fix: opDepositUsdc '3.0' → '0.10' 동기화
4f20f425  2026-06-16  fix: operatorDeposit 에러 메시지 응답 포함 (디버그)
49d48565  2026-06-16  fix: hold_deadline to_timestamp SQL 복원
f72a12245  2026-06-16  fix: hold_deadline unix초 정수로 저장
d9e60c74  2026-06-16  fix: endSchema userFinalSig optional
efe321da  2026-06-16  revert: sessions.js b8b23fd 기준 롤백
1f19f1d8  2026-06-16  revert: escrowPayoutService V3.2 적용
```

---

## 14. E2E 테스트 재실행 방법

백엔드 Railway Redeploy 후 아래 스크립트로 전체 13케이스 검증:

```python
# 환경변수 필요:
# OPERATOR_PRIVATE_KEY=0x...
# BASESCAN_API_KEY=...
# GITHUB_TOKEN=...

# 주요 케이스:
# TC01: GET /health → redis+db ok
# TC02: POST /sessions/start → escrowId=keccak(sessionId), holdDeadline 유효
# TC03: USDC.approve + Contract.userDeposit → TX Success
# TC04: 온체인 getEscrowStatus → state=1 (UserDeposited)
# TC05: POST /sessions/:id/deposit → operatorDeposit txHash 반환
# TC06: 온체인 getEscrowStatus → state=2 (FullyFunded)
# TC07: POST /channels/:id/update {chargeUsdc, userSig, userAddress, nonce} → ok
# TC08: GET /sessions/:id/escrow-status → dbState, onchain.state 확인
# TC09: POST /sessions/:id/end → fareUsdc, refundUsdc 반환
# TC10: holdDeadline 경과 후 온체인 state=4 (Released) 확인 (60초 대기 필요)
# TC11: 0 USDC 세션 → 컨트랙트 ZeroAmount revert 보장
# TC12: POST /refunds {reason: 'test'} → caseId 반환
# TC13: GET /sessions/없는ID/escrow-status → found=false
```

---

## 15. 중요 지침 (절대 위반 금지)

1. **모든 결제/정산은 0xa2642876a2Aa9F19D22a6e69379bbcA10556977f 만 사용**
2. **사용자의 userDeposit TX를 백엔드가 대신 실행하지 말 것** (MetaMask 직접 서명 필수)
3. **정산 계산은 클라이언트 값 아닌 DB의 serviceStartedAt 기준**
4. **컨트랙트 주소 변경 시 환경변수(.env) 및 walletUtils.js 동시 업데이트**
5. **operatorDeposit 금액 = userDeposit 금액 (동일해야 FullyFunded)**
6. **hold_deadline DB 저장: to_timestamp(unix_seconds) 형식 사용**
7. **escrowId 인코딩: bytes.fromhex(eid_hex[2:]) — 0x 제거 후 hex 디코딩**
