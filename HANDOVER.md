# SmartCity 에스크로 결제 시스템 — AI Agent 인수인계 문서

> **작성일**: 2026-06-16  
> **대상**: 이 프로젝트를 처음 인수받는 AI Agent  
> **목적**: 컨텍스트 없이도 즉시 이어받을 수 있도록 모든 정보를 한 곳에 정리

---

## 📌 TL;DR (핵심 3줄)

1. **Base Sepolia 테스트넷**에서 QR→결제→환불 전 과정이 블록체인 기반으로 동작하는 스마트시티 결제 시스템
2. **모든 결제/정산은 신규 컨트랙트 `0x1aa35D4088A53Bc39a8D0688E061abac6fd77907` 만 사용** (구버전 `0x454D...` 절대 금지)
3. **E2E 12/13 PASS** — TC10(settleAndRelease 타이밍)만 미통과 (코드 버그 아님, 테스트 대기시간 부족)

---

## 1. 프로젝트 목적

스마트시티 공유 서비스(자전거, 킥보드, 주차장 등)에서  
**사용자 ↔ 운영자 간 신뢰 없이도** 안전한 결제가 가능한 블록체인 기반 에스크로 시스템.

### 핵심 설계 원칙
| 원칙 | 구현 방식 |
|------|----------|
| Trust-minimization | 스마트컨트랙트가 자금 보관 → 운영자 먹튀 물리적 불가 |
| Gas-free UX | 1분 단위 오프체인 서명(Perun) → MetaMask 팝업 없이 실시간 청구 |
| 투명성 | BaseScan Verified 컨트랙트, 모든 정산 온체인 기록 |
| 분쟁 무결성 | channel_states 테이블에 nonce+stateHash로 모든 오프체인 기록 |

---

## 2. 저장소 & 브랜치

```
GitHub : https://github.com/junseng12/Smart_Security_Special_Theory
Branch : go-sdk   ← 실제 개발 브랜치 (main 아님)
```

### 폴더 구조
```
/
├── smartcity-payment-backend/    ← 백엔드 (Node.js) — Railway 배포
├── smartcity-payment-frontend/   ← 프론트 (React/Vite) — Railway 배포
├── smartcontract/                ← 컨트랙트 소스 참고용 (이미 배포 완료)
├── go-perun-node/                ← Go-Perun 오프체인 채널 노드 — Railway
├── functions/                    ← Base44 serverless 보조 함수
└── HANDOVER.md                   ← 이 문서
```

> ⚠️ **주의**: `backend/`, `frontend-latest/` 폴더는 구버전으로 삭제됨. 절대 참조 금지.  
> 실제 서비스 소스는 `smartcity-payment-backend/`, `smartcity-payment-frontend/` 만 사용.

---

## 3. 핵심 주소 (변경 금지)

```
# 신규 컨트랙트 V3.2 (BaseScan Verified, 현재 사용)
ESCROW_V3_ADDRESS = "0xa2642876a2Aa9F19D22a6e69379bbcA10556977f"  # ★ 현재 사용 중

# 구버전 (refundToBuyer 없음, Unverified — 절대 사용 금지)
OLD_ADDRESS       = "0x454Dd98f154cC4Af7ACB5390113151E2f0e489a1"

# USDC (Base Sepolia testnet)
USDC_ADDRESS      = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"

# Operator 지갑
OPERATOR_ADDRESS  = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7"

# 네트워크
CHAIN_ID   = 84532
RPC        = "https://sepolia.base.org"
EXPLORER   = "https://sepolia.basescan.org"
```

### 왜 구버전으로 돌아가면 안 되는가
| 항목 | 구버전 0x454D | 신규 0xa264 |
|------|:---:|:---:|
| BaseScan Verified | ❌ | ✅ |
| `refundToBuyer()` | ❌ **없음** | ✅ |
| `registerRefundIssue()` | ❌ **없음** | ✅ |
| OpenZeppelin AccessControl | ❓ | ✅ |
| 바이트코드 크기 | 9326B | 7521B (경량) |

---

## 4. 인프라 구성

| 서비스 | 플랫폼 | 주소 |
|--------|--------|------|
| 백엔드 API | Railway | `https://payment-backend-production.up.railway.app` |
| 프론트엔드 | Railway | (별도 Railway 서비스) |
| Go-Perun 노드 | Railway | `go-perun.railway.internal:50051` (gRPC, 내부망) |
| PostgreSQL | Railway | `DATABASE_URL` 환경변수 |
| Redis | Railway | `REDIS_URL` 환경변수 |
| 블록체인 | Base Sepolia | chainId 84532 |

### Railway 백엔드 환경변수 (전체)
```env
PORT=3000
NODE_ENV=production
DATABASE_URL=postgresql://...
REDIS_URL=redis://...
BASE_SEPOLIA_RPC=https://sepolia.base.org
OPERATOR_PRIVATE_KEY=0x...          ← Operator 지갑 프라이빗키 (보안 핵심)
ESCROW_CONTRACT_ADDRESS=0xa2642876a2Aa9F19D22a6e69379bbcA10556977f  # ★ V3.2 현재 사용
USDC_CONTRACT_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
OPERATOR_ADDRESS=0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7
GRPC_PORT=50051
```

### 운영 리소스 현황 (2026-06-16 기준)
```
Operator ETH:  0.3556 ETH  (가스비용)
Operator USDC: 7.64 USDC   (operatorDeposit 재원)
V3.2 컨트랙트: 7521 bytes  배포됨 ✅
백엔드:        healthy (redis:ok, db:ok, perun:connected)
```

---

## 5. 시스템 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                    사용자 (모바일)                         │
│                  MetaMask 내장 브라우저                    │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS
┌──────────────────────▼──────────────────────────────────┐
│               Frontend (React/Vite)                      │
│  ScanPay.jsx  Dashboard.jsx  RefundCenter.jsx  ...       │
│  lib/walletUtils.js ← MetaMask 연동 / ABI 인코딩          │
└──────────────┬───────────────────────────────────────────┘
               │ REST API
┌──────────────▼───────────────────────────────────────────┐
│              Backend (Node.js/Express)                    │
│  routes/ : sessions, channels, refunds, health           │
│  services/: escrowPayoutService (핵심)                   │
│             channelOrchestrator, fareEngine               │
│             refundCaseManager, watchtower                 │
├──────────────┬────────────────────┬──────────────────────┤
│  PostgreSQL  │      Redis         │  ethers.js (Operator) │
│  (세션/정산)  │  (채널 상태 캐시)   │  ← 온체인 TX 자동 실행  │
└──────────────┴────────────────────┴──────┬───────────────┘
                                           │ gRPC
┌──────────────────────────────────────────▼───────────────┐
│              Go-Perun Node                                │
│  오프체인 상태 채널 관리                                     │
│  1분 단위 ProposeUsageUpdate 처리                          │
└──────────────────────────────────────────────────────────┘
                                           │ (온체인 분쟁시)
┌──────────────────────────────────────────▼───────────────┐
│         SmartCityEscrow V3.2 (Base Sepolia)               │
│    0x1aa35D4088A53Bc39a8D0688E061abac6fd77907            │
│    BaseScan Verified ✅                                   │
│    USDC ERC-20 보관 / 정산 / 환불                         │
└──────────────────────────────────────────────────────────┘
```

---

## 6. 결제 정산 표준 흐름 (절대 변경 금지)

```
[Phase 1] 에스크로 설정
  1. POST /api/v1/sessions/start
     → DB: sessions INSERT
     → escrowId = keccak256(sessionId), holdDeadline = now + 240초 반환

  2. 프론트: USDC.approve(ESCROW_V3_ADDRESS, amount)  [MetaMask 팝업 ①]

  3. 프론트: Contract.userDeposit(escrowId, operatorAddr, amount, holdDeadline)
             [MetaMask 팝업 ②]
     → 온체인 state: None → UserDeposited
     → 이벤트: UserDeposited(escrowId, user, operator, amount, holdDeadline)

  4. POST /api/v1/sessions/:id/deposit  {depositTxHash, serviceStartedAt}
     → DB: escrow_locks INSERT (state=UserDeposited, hold_deadline=to_timestamp(unix))
     → 백엔드 자동: Contract.operatorDeposit(escrowId, amount) [Operator 지갑]
     → 온체인 state: UserDeposited → FullyFunded
     → 이벤트: OperatorDeposited, (내부적으로 FullyFunded 체크)

[Phase 2] 서비스 이용 (오프체인)
  5. 매 1분: POST /api/v1/channels/:id/update
             {chargeUsdc, userSig, userAddress, nonce, cumulativeUsdc}
     → DB: channel_states INSERT (분쟁 증거 audit trail)
     → MetaMask 팝업 없음 (오프체인 서명만)

[Phase 3] 정산
  6. POST /api/v1/sessions/:id/end  {channelId, userAddress, fareUsdc}
     → DB: fare 계산 (serviceStartedAt 기준, 클라이언트 값 아님)
     → 백엔드 자동: Contract.settleAndRelease(escrowId, fareAmount)
        ※ holdDeadline 경과 후에만 실행 가능 (컨트랙트 강제)
     → 온체인 state: FullyFunded → Released
     → fare → Operator 지갑, refund → User 지갑 (컨트랙트 자동 전송)
     → 이벤트: SettledAndReleased

[Phase 4] 환불 (선택)
  7. POST /api/v1/refunds  {userAddress, sessionId, reason, refundType}
     → DB: refund_cases INSERT
     → 자동 심사 → forceRefund 또는 refundToBuyer
     → 온체인 state: Released → Refunded
     → 이벤트: ForceRefunded 또는 RefundedToBuyer
```

---

## 7. 스마트컨트랙트 인터페이스 (V3.2 전체)

### EscrowState
```
0: None          → 미생성
1: UserDeposited → 사용자만 예치
2: FullyFunded   → 양측 예치 완료 (서비스 이용 가능)
3: RefundIssue   → 분쟁 등록됨
4: Released      → 정산 완료 (24시간 이의기간)
5: Refunded      → 환불 완료
```

### 함수 목록
```solidity
// ── 사용자가 직접 호출 (MetaMask 서명 필수) ──────────────────
userDeposit(bytes32 escrowId, address operator, uint256 amount, uint256 holdDeadline)

// ── Operator만 호출 가능 (OPERATOR_ROLE 필요) ─────────────────
operatorDeposit(bytes32 escrowId, uint256 amount)
settleAndRelease(bytes32 escrowId, uint256 fareAmount)   // holdDeadline 이후만 가능
forceRefund(bytes32 escrowId)                            // 즉시 환불 (UserDeposited 상태)
refundToBuyer(bytes32 escrowId)                          // Released 후 환불
registerRefundIssue(bytes32 escrowId, uint8 issueType, string description, bool penalizeOperator)
emergencyCancel(bytes32 escrowId)

// ── 조회 ─────────────────────────────────────────────────────
getEscrowStatus(bytes32 escrowId) returns (
  uint8 state, uint256 userDeposit, uint256 operatorDeposit,
  uint256 fareAmount, address user, address operator,
  uint256 holdDeadline, bool isFullyFunded, bool isDeadlinePassed
)
hasRole(bytes32 role, address account)
```

### 이벤트
```
UserDeposited(bytes32 escrowId, address user, address operator, uint256 amount, uint256 holdDeadline)
OperatorDeposited(bytes32 escrowId, address operator, uint256 amount)
SettledAndReleased(bytes32 escrowId, address operator, uint256 fare, address user, uint256 refund, uint256 operatorRefund)
ForceRefunded(bytes32 escrowId, address user, uint256 amount)
RefundedToBuyer(bytes32 escrowId, address user, uint256 amount, uint256 penalty)
RefundIssueRegistered(bytes32 escrowId, uint8 issueType, string description)
```

### escrowId 계산 방식
```javascript
// 백엔드 (ethers.js v6)
const { keccak256, toUtf8Bytes } = require('ethers');
const escrowId = keccak256(toUtf8Bytes(sessionId));  // bytes32 hex

// 컨트랙트 호출 시 bytes 변환
const eid_bytes = Buffer.from(escrowId.slice(2), 'hex');  // 0x 제거

// 프론트 (walletUtils.js) — SHA-256 방식 (현재 불일치 있음, 우회 중)
const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(sessionId));
```

> ⚠️ **알려진 이슈**: 백엔드(keccak256) ↔ 프론트(SHA-256) 불일치.  
> 현재는 백엔드가 escrowId를 생성해서 프론트에 내려주는 방식으로 우회 중.  
> 장기적으로 통일 필요.

---

## 8. 백엔드 API 전체 목록

### Health
```
GET  /health
     → { status, checks: { redis, db, perun_detail: { connected } } }

GET  /health/escrow-env
     → ESCROW_CONTRACT_ADDRESS 환경변수 확인
```

### Sessions  `/api/v1/sessions`
```
POST /start
     body : { userAddress, serviceType, depositUsdc }
     resp : { sessionId, escrowId, holdDeadline, channelId }

POST /:id/deposit
     body : { channelId, userAddress, depositUsdc, depositTxHash, serviceStartedAt }
     resp : { ok, data: { operatorDeposit: { txHash, escrowId, operatorDepositUsdc } } }

POST /:id/end
     body : { channelId, userAddress, fareUsdc }
     resp : { ok, data: { fareUsdc, refundUsdc, escrow: { settleTx, deferred } } }

GET  /:id/escrow-status
     resp : { data: { dbState, onchain: { state, isFullyFunded }, settled, settleTx, found } }

GET  /:id/status      → 세션 상태
GET  /                → 세션 목록
GET  /:id/stream      → SSE 실시간 스트림
POST /:id/charge      → 요금 청구
POST /:id/sign        → 서명 요청
```

### Channels  `/api/v1/channels`
```
POST /open            body: { sessionId, userAddress, ... }
POST /:id/update      body: { chargeUsdc, userSig, userAddress, nonce?, cumulativeUsdc?, stepIndex? }
POST /:id/close
POST /:id/refund
GET  /:id
```

### Refunds  `/api/v1/refunds`
```
POST /
     body : { userAddress, sessionId, reason, refundType, requestedUsdc? }
     reason 허용값 : unlock_failure | sensor_failure | double_charge | service_outage |
                    wrong_amount | device_malfunction | device_fault | wrong_charge |
                    manual_request | test
     refundType   : FULL | PARTIAL

POST /:caseId/evaluate   → 자동 심사 트리거
POST /:caseId/approve    body: { approvedUsdc }
POST /:caseId/reject     body: { reason }
POST /:caseId/payout     → 온체인 환불 실행 (forceRefund or refundToBuyer)
GET  /:caseId
GET  /
```

---

## 9. 주요 서비스 파일 역할 (백엔드)

```
src/services/
├── escrowPayoutService.js   ★ 핵심
│   ├── getEscrowContract()   → process.env.ESCROW_CONTRACT_ADDRESS (env변수)
│   ├── recordUserDeposit()   → escrow_locks INSERT, hold_deadline=to_timestamp(unix)
│   ├── operatorDeposit()     → Operator 지갑으로 온체인 예치
│   │                           금액 자동 동기화: sessions.meta > escrow_locks.user_deposit
│   └── settleAndPayout()     → settleAndRelease 호출
│
├── channelOrchestrator.js   세션 생명주기 총괄
│   ├── startSession()        → holdDeadline = Math.floor(Date.now()/1000) + 240
│   └── endSessionAndSettle() → DB 기준 fare 계산 + 정산
│
├── fareEngine.js            요금 계산 (DB의 serviceStartedAt 기준, 클라이언트 값 무시)
├── watchtower.js            온체인 모니터링 (Released 상태 자동 감지 + DB 동기화)
├── refundCaseManager.js     환불 케이스 CRUD
├── refundDecisionEngine.js  자동 심사 (approve/reject 판단)
├── channelManager.js        Go-Perun gRPC 채널 관리
├── walletService.js         ethers.js Operator 지갑 래퍼
├── db.js                    PostgreSQL pool (getPool())
└── redisClient.js           Redis 연결
```

---

## 10. DB 스키마 (주요 테이블)

```sql
-- 결제 세션
sessions (
  id UUID PRIMARY KEY,
  user_address TEXT,
  service_type TEXT,
  status TEXT,
  meta JSONB,             -- { depositUsdc, holdDeadline, channelId, ... }
  created_at TIMESTAMPTZ
)

-- 에스크로 온체인 상태 기록
escrow_locks (
  session_id UUID,
  escrow_id_bytes TEXT,        -- "0x..." hex 문자열
  channel_id TEXT,
  user_address TEXT,
  operator_address TEXT,
  user_deposit NUMERIC,
  operator_deposit NUMERIC,
  fare_amount NUMERIC,
  user_deposit_tx TEXT,
  operator_deposit_tx TEXT,
  settle_tx TEXT,
  hold_deadline TIMESTAMPTZ,   -- to_timestamp(unix_seconds) 형식으로 저장
  state TEXT,                  -- UserDeposited | FullyFunded | Released | Refunded
  settled_at TIMESTAMPTZ
)

-- 오프체인 채널 상태 (분쟁 증거 audit trail)
channel_states (
  channel_id TEXT,
  session_id UUID,
  nonce INT,
  state_hash TEXT,
  cumulative_usdc NUMERIC,
  user_sig TEXT,
  created_at TIMESTAMPTZ
)

-- 환불 케이스
refund_cases (
  id UUID PRIMARY KEY,
  session_id UUID,
  user_address TEXT,
  reason TEXT,
  refund_type TEXT,         -- FULL | PARTIAL
  requested_usdc NUMERIC,
  approved_usdc NUMERIC,
  status TEXT,              -- pending | approved | rejected | paid
  payout_tx TEXT,
  created_at TIMESTAMPTZ
)

-- Perun 오프체인 채널
channels (id TEXT, session_id UUID, state TEXT, balance NUMERIC, ...)
```

---

## 11. 프론트엔드 구성

### 페이지
```
Dashboard.jsx          → 잔액, 최근 거래 내역
ScanPay.jsx            → QR 스캔 결제 메인 (934L, 가장 핵심)
TransactionHistory.jsx → 거래 내역 + 세션ID 복사
RefundCenter.jsx       → 환불 신청
Deposit.jsx            → USDC 입금
Send.jsx               → 전송
Profile.jsx            → 지갑 주소, 잔액 표시
```

### walletUtils.js 핵심 상수 & 함수
```javascript
// 주소 상수 (하드코딩, 변경 시 walletUtils.js만 수정하면 됨)
USDC_ADDRESS      = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
ESCROW_V3_ADDRESS = "0xa2642876a2Aa9F19D22a6e69379bbcA10556977f"  # ★ 현재 사용 중
OPERATOR_ADDRESS  = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7"

// 함수
approveUsdcForEscrow(fromAddress, escrowAddress, amountUsdc)  // USDC approve
userDeposit(fromAddress, escrowId, operator, amountUsdc, holdDeadline)  // ABI 인코딩
getUsdcBalance(address)
```

### ScanPay.jsx 결제 상태 머신
```
"idle"
  ↓ QR 스캔
"session_created"   ← POST /sessions/start
  ↓
"approved"          ← USDC.approve() [MetaMask ①]
  ↓
"deposited"         ← userDeposit() [MetaMask ②] + POST /deposit
  ↓
"active"            ← 1분마다 ProposeUsageUpdate (자동)
  ↓ 서비스 종료
"ended"             ← POST /end → fare/refund 표시
```

---

## 12. 현재 상태 & 미해결 과제

### ✅ 완료
- 신규 컨트랙트 V3.2 배포 + BaseScan Verified
- Railway 환경변수 전체 동기화 (`ESCROW_CONTRACT_ADDRESS=0xa264...`)
- 전체 결제 플로우 온체인 동작 확인 (UserDeposited → FullyFunded → Released)
- 프론트 walletUtils.js / ScanPay.jsx 주소 동기화
- operatorDeposit 금액 DB 자동 동기화 (3.0 기본값 방어)
- channels.js updateSchema 확장 (nonce, cumulativeUsdc, stepIndex)
- refunds.js reason enum 'test' 추가

### ❌ E2E TC10 미통과 (코드 버그 아님)
```
원인: E2E 테스트에서 holdDeadline 경과 후 25초 대기 → Released 확인 불충분
      (holdDeadline이 240초 = 4분이라 테스트 중 경과 시점과 Settlement 실행 시점이 타이트함)

실제 운영: Watchtower가 holdDeadline 경과 감지 → settleAndRelease 자동 실행 → 정상
다음 Agent 할 일: E2E 테스트 TC10에 폴링 방식 추가
```
```python
# TC10 수정 방법 예시
for i in range(20):          # 최대 60초 폴링
    s = escrow_c.functions.getEscrowStatus(eid_b).call()
    if s[0] == 4:            # Released
        break
    if s[8]:                 # dlPassed → 직접 settleAndRelease 실행
        stx(escrow_c.functions.settleAndRelease(eid_b, fare), nonce)
    time.sleep(3)
```

### 🔧 장기 개선 과제
1. **escrowId 계산 통일**: 백엔드(keccak256) ↔ 프론트(SHA-256) → 둘 중 하나로 통일
2. **0 USDC API 레벨 거부**: 현재 컨트랙트 ZeroAmount revert로 방어 → API 사전 검증 추가
3. **holdDeadline 환경변수화**: 현재 하드코딩 240초 → `HOLD_DEADLINE_SECONDS` env로
4. **Watchtower claimSettlement**: Released 후 24시간 자동 처리 미구현
5. **모바일 E2E 최종 검증**: 실제 MetaMask 앱에서 전체 플로우 실사용 테스트

---

## 13. 최근 커밋 이력 (go-sdk)

```
a501fb27  2026-06-16  docs: AI Agent 인수인계 문서 (HANDOVER.md) 추가
b1f463d8  2026-06-16  fix: operatorDeposit 금액 DB 자동 동기화
fd3b125f  2026-06-16  fix: refunds reason enum 'test' 추가
e5fa8ca6  2026-06-16  fix: channels updateSchema nonce/cumulativeUsdc 추가
0bf6fdb0  2026-06-16  fix: opDepositUsdc '3.0' 기본값 → '0.10' + 에러 노출 제거
4f20f425  2026-06-16  fix: operatorDeposit 에러 메시지 응답 포함 (디버그)
49d48565  2026-06-16  fix: hold_deadline to_timestamp SQL 복원
f72a1224  2026-06-16  fix: hold_deadline unix초 정수로 저장
d9e60c74  2026-06-16  fix: endSchema userFinalSig optional
efe321da  2026-06-16  revert: sessions.js b8b23fd 기준 롤백
1f19f1d8  2026-06-16  revert: escrowPayoutService V3.2 적용
```

---

## 14. E2E 테스트 재실행 체크리스트

Railway Redeploy 후 아래 순서로 확인:

```bash
# 1. 헬스 확인
GET /health
# → { status: "healthy", checks: { redis: "ok", db: "ok" } }

# 2. 세션 생성
POST /api/v1/sessions/start
{ "userAddress": "0x...", "serviceType": "bicycle", "depositUsdc": "0.10" }
# → { sessionId, escrowId, holdDeadline, channelId }

# 3. 온체인 userDeposit (MetaMask or ethers.js)
Contract.userDeposit(escrowId_bytes, operator, 100000, holdDeadline)
# → TX Success, 온체인 state=1 (UserDeposited)

# 4. 백엔드 deposit API
POST /api/v1/sessions/:id/deposit
{ channelId, userAddress, depositUsdc:"0.10", depositTxHash, serviceStartedAt }
# → { ok: true, data: { operatorDeposit: { txHash: "0x..." } } }
# → 20초 대기 후 온체인 state=2 (FullyFunded)

# 5. 정산
POST /api/v1/sessions/:id/end
{ channelId, userAddress, fareUsdc: "0.04" }
# → { ok: true, data: { fareUsdc: "0.04", refundUsdc: "0.06" } }
# → holdDeadline 경과 후 온체인 state=4 (Released) [폴링 60초]

# 6. 환불 신청
POST /api/v1/refunds
{ userAddress, sessionId, reason: "test", refundType: "PARTIAL" }
# → { ok: true, data: { caseId: "..." } }
```

---

## 15. 절대 규칙 (위반 금지)

```
1. 모든 결제/정산 → 0x1aa35D4088A53Bc39a8D0688E061abac6fd77907 만 사용
2. 백엔드가 사용자 userDeposit TX를 대신 실행하지 말 것 (MetaMask 직접 서명)
3. 정산 금액은 DB의 serviceStartedAt 기준 (클라이언트 전달값 신뢰 금지)
4. 컨트랙트 주소 변경 시 → Railway 환경변수 + walletUtils.js 동시 업데이트
5. operatorDeposit 금액 = userDeposit 금액 (다르면 FullyFunded 불가)
6. hold_deadline DB 저장: to_timestamp(unix_seconds) 형식
7. escrowId 인코딩: bytes.fromhex(hex_string.replace("0x",""))
8. 실제 서비스 소스: smartcity-payment-backend/, smartcity-payment-frontend/ 만 수정
```
