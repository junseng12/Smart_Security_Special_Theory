# 🚌 SmartCity Micro-Payment Backend

> Base 체인 + Perun 스테이트 채널 기반 스마트시티 마이크로 결제 시스템  
> Node.js | PostgreSQL | Redis | Solidity | Base Sepolia

---

## 📌 프로젝트 개요

스마트시티 환경에서 전동 킥보드, 버스, 주차 등 **다양한 모빌리티 서비스**에 대한  
**실시간 마이크로 결제**를 처리하는 백엔드 시스템입니다.

### 핵심 특징

| 특징 | 설명 |
|------|------|
| ⚡ 고빈도 결제 | Perun 스테이트 채널로 온체인 없이 즉각 처리 |
| 🔐 에스크로 보호 | SmartCityEscrow 컨트랙트로 자금 안전 보관 |
| 💸 자동 환불 | 분쟁 발생 시 판단 엔진이 자동으로 환불 처리 |
| 📊 이중 저장 | Redis(핫 상태) + PostgreSQL(영구 저장) |
| 🛡️ 감사 추적 | 요금 정책 버전 관리 + 전체 트랜잭션 로깅 |

---

## 🏗️ 시스템 아키텍처

```
사용자 기기 (킥보드/버스/주차)
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│                   REST API Server (Express)              │
│  /sessions  /channels  /refunds  /health                 │
└─────────────────┬───────────────────────────────────────┘
                  │
     ┌────────────┼────────────┐
     ▼            ▼            ▼
┌─────────┐ ┌─────────┐ ┌──────────┐
│ Session │ │ Channel │ │  Refund  │
│ Manager │ │ Orches- │ │  Case    │
│         │ │ trator  │ │  Manager │
└────┬────┘ └────┬────┘ └────┬─────┘
     │            │           │
     ▼            ▼           ▼
┌─────────────────────────────────────────────────────────┐
│                    Core Services                         │
│  FareEngine │ SignatureManager │ SettlementManager       │
│  WalletService │ Watchtower │ EscrowPayoutService        │
└──────────────────────┬──────────────────────────────────┘
                       │
         ┌─────────────┼──────────────┐
         ▼             ▼              ▼
   ┌──────────┐  ┌──────────┐  ┌──────────────────────┐
   │  Redis   │  │PostgreSQL│  │  Base Sepolia Chain   │
   │ (핫상태) │  │ (영구DB) │  │  SmartCityEscrow.sol  │
   └──────────┘  └──────────┘  └──────────────────────┘
```

---

## 📁 프로젝트 구조

```
smartcity-payment-backend/
│
├── contracts/                  # 스마트 컨트랙트
│   └── SmartCityEscrow.sol     # 에스크로 컨트랙트 (Push 방식)
│
├── artifacts/                  # 컴파일된 컨트랙트 ABI + Bytecode
│   └── SmartCityEscrow.json
│
├── src/
│   ├── index.js                # 서버 진입점 (Express + gRPC)
│   │
│   ├── routes/                 # REST API 라우터
│   │   ├── sessions.js         # 세션 생성/조회/종료
│   │   ├── channels.js         # 채널 관리
│   │   ├── refunds.js          # 환불 케이스 처리
│   │   └── health.js           # 헬스체크
│   │
│   ├── services/               # 핵심 비즈니스 로직
│   │   ├── sessionManager.js       # 세션 라이프사이클
│   │   ├── channelOrchestrator.js  # 채널 오케스트레이션
│   │   ├── channelManager.js       # 채널 상태 관리
│   │   ├── fareEngine.js           # 요금 계산 엔진
│   │   ├── signatureManager.js     # 상태 서명 관리
│   │   ├── settlementManager.js    # 채널 정산
│   │   ├── refundCaseManager.js    # 환불 케이스 관리
│   │   ├── refundDecisionEngine.js # 환불 자동 판단
│   │   ├── escrowPayoutService.js  # 에스크로 지급 처리
│   │   ├── walletService.js        # 지갑/서명 서비스
│   │   ├── watchtower.js           # 채널 감시 프로세스
│   │   ├── perunClient.js          # Perun 프로토콜 클라이언트
│   │   ├── db.js                   # PostgreSQL 연결
│   │   └── redisClient.js          # Redis 연결
│   │
│   ├── middleware/             # Express 미들웨어
│   │   ├── errorHandler.js     # 전역 에러 핸들러
│   │   └── requestValidator.js # 요청 유효성 검사
│   │
│   ├── proto/                  # gRPC 프로토 정의
│   │   └── perun.proto
│   │
│   └── utils/                  # 유틸리티
│       ├── logger.js           # 구조화 로깅
│       └── sseClients.js       # SSE 클라이언트 관리
│
├── scripts/                    # 운영 스크립트
│   ├── compile.js              # 컨트랙트 컴파일 (solc)
│   ├── deploy.js               # Base Sepolia 배포
│   └── setup-db.js             # DB 마이그레이션 + 연결 테스트
│
├── test/                       # 테스트
│   ├── e2e.test.js             # E2E 통합 테스트 (실 DB 연동)
│   ├── integration.test.js     # 서비스 통합 테스트
│   ├── fareEngineLocal.js      # 요금 엔진 단위 테스트
│   ├── orchestratorLocal.js    # 오케스트레이터 단위 테스트
│   ├── refundLocal.js          # 환불 로직 단위 테스트
│   └── sessionLocal.js         # 세션 로직 단위 테스트
│
├── docker-compose.yml          # 로컬 개발 환경 (Redis + PostgreSQL)
├── Dockerfile                  # 프로덕션 도커 이미지
├── package.json
└── README.md
```

---

## 🔄 결제 흐름

### 1. 정상 결제 흐름

```
① 사용자가 서비스 시작 (킥보드 잠금 해제 등)
        │
        ▼
② createSession() → Perun 채널 오픈 + 에스크로 자금 예치
        │
        ▼
③ 서비스 이용 중: 오프체인 상태 업데이트 (서명 교환)
   [nonce 1] → [nonce 2] → [nonce 3] → ...
        │
        ▼
④ 서비스 종료 → FareEngine이 최종 요금 계산
        │
        ▼
⑤ SettlementManager → 최종 상태로 채널 정산
        │
        ▼
⑥ EscrowPayoutService → releaseToSeller() 호출
   운영자에게 요금 지급, 잔액 사용자 환불
```

### 2. 환불 흐름 (분쟁 발생 시)

```
① 사용자가 환불 요청 (센서 오류, 서비스 불량 등)
        │
        ▼
② RefundCaseManager → 케이스 생성 (RECEIVED)
        │
        ▼
③ RefundDecisionEngine → 자동 판단
   - 센서 오류: 자동 APPROVED
   - 금액 이슈: 수동 검토 (REVIEWING)
        │
        ▼
④ APPROVED → EscrowPayoutService → refundToBuyer()
   에스크로 컨트랙트에서 사용자에게 직접 환불
        │
        ▼
⑤ 케이스 CLOSED, 트랜잭션 기록
```

---

## 🗄️ 데이터베이스 스키마

| 테이블 | 설명 |
|--------|------|
| `sessions` | 결제 세션 (서비스 이용 단위) |
| `channels` | Perun 스테이트 채널 |
| `channel_states` | 채널 상태 히스토리 (nonce별) |
| `fare_policies` | 요금 정책 (버전 관리) |
| `fare_calculations` | 요금 계산 기록 |
| `signature_requests` | 서명 요청/검증 기록 |
| `settlements` | 정산 트랜잭션 기록 |
| `refund_cases` | 환불 케이스 |
| `refund_transactions` | 환불 트랜잭션 |
| `escrow_locks` | 에스크로 상태 추적 |

---

## 📜 스마트 컨트랙트

### SmartCityEscrow.sol

**배포 정보 (Base Sepolia)**

| 항목 | 값 |
|------|-----|
| 컨트랙트 주소 | `0xf6B7d5c6C7a907D906419125B9dD2EeeCb26De3c` |
| 운영자 주소 | `0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7` |
| USDC (Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| TX Hash | `0xd2d288217c73a68ac2991539734acf5738ee3b102cbc55514b59dda71c631eb0` |
| Explorer | [BaseScan에서 보기](https://sepolia.basescan.org/address/0xf6B7d5c6C7a907D906419125B9dD2EeeCb26De3c) |

**상태 전이**

```
Held ──→ ReleasedToSeller  (정상 정산)
Held ──→ RefundIssue ──→ Refunded  (분쟁/환불)
Held ──→ Cancelled  (긴급 취소)
```

**주요 함수**

```solidity
// 에스크로 생성 (세션 시작 시)
createEscrow(bytes32 escrowId, address buyer, address seller, uint256 amount, uint256 holdDeadline)

// 환불 이슈 등록
registerRefundIssue(bytes32 escrowId, uint8 issueType, string description)

// 판매자에게 지급 (정상 정산)
releaseToSeller(bytes32 escrowId)

// 구매자에게 환불
refundToBuyer(bytes32 escrowId)
```

---

## 🚀 시작하기

### 사전 요구사항

- Node.js 18+
- PostgreSQL 14+ (또는 Supabase)
- Redis 6+ (또는 Upstash)

### 1. 의존성 설치

```bash
npm install
```

### 2. 환경변수 설정

```bash
cp .env.example .env
```

`.env` 파일 작성:

```env
# 서버
PORT=3000
NODE_ENV=development

# PostgreSQL
DATABASE_URL=postgresql://user:password@host:5432/dbname

# Redis
REDIS_URL=rediss://default:password@host:6379

# 블록체인
BASE_SEPOLIA_RPC=https://sepolia.base.org
OPERATOR_PRIVATE_KEY=0x...
ESCROW_CONTRACT_ADDRESS=0xf6B7d5c6C7a907D906419125B9dD2EeeCb26De3c
USDC_CONTRACT_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
OPERATOR_ADDRESS=0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7
```

### 3. DB 마이그레이션

```bash
node scripts/setup-db.js
```

### 4. 서버 실행

```bash
npm start
```

### 5. 컨트랙트 컴파일 & 배포 (선택)

```bash
# 컴파일
node scripts/compile.js

# Base Sepolia 배포
node scripts/deploy.js
```

---

## 🧪 테스트

### E2E 통합 테스트 (실 DB 연동)

```bash
node test/e2e.test.js
```

25개 테스트 시나리오:
- PostgreSQL/Redis 연결
- Channel CRUD + 상태 히스토리
- Session 생성 → Settled 전이
- Fare Calculation, Signature, Settlement
- Refund Case 상태 전이 (RECEIVED → CLOSED)
- Escrow Lock 상태 전이 (Held → Refunded)
- 전체 흐름 JOIN 조회

### 단위 테스트

```bash
node test/fareEngineLocal.js       # 요금 계산
node test/sessionLocal.js          # 세션 로직
node test/refundLocal.js           # 환불 로직
node test/orchestratorLocal.js     # 오케스트레이터
```

---

## 🌐 API 엔드포인트

### Sessions
| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/sessions` | 새 결제 세션 시작 |
| GET | `/sessions/:id` | 세션 조회 |
| POST | `/sessions/:id/end` | 세션 종료 |

### Channels
| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/channels` | 채널 개설 |
| GET | `/channels/:id` | 채널 상태 조회 |
| POST | `/channels/:id/update` | 상태 업데이트 (오프체인) |
| POST | `/channels/:id/settle` | 채널 정산 |

### Refunds
| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/refunds` | 환불 요청 |
| GET | `/refunds/:caseId` | 환불 케이스 조회 |
| POST | `/refunds/:caseId/approve` | 환불 승인 |
| POST | `/refunds/:caseId/reject` | 환불 거절 |

### Health
| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/health` | 서버/DB/Redis 상태 확인 |

---

## 🐳 Docker로 실행

```bash
# 전체 스택 실행 (앱 + Redis + PostgreSQL)
docker-compose up -d

# 로그 확인
docker-compose logs -f app
```

---

## 🔒 보안 고려사항

- Private Key는 절대 코드에 하드코딩 금지 → 환경변수 사용
- 모든 서명은 `SignatureManager`를 통해 검증
- PostgreSQL SSL 강제 적용 (Supabase)
- Redis TLS 연결 (Upstash)

---

## 📄 라이선스

MIT License

---

## 🤝 기여

PR과 Issue 환영합니다!
