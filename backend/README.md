# SmartCity Payment Backend

> Node.js 백엔드 — Perun State Channel + Base L2 + USDC

## 아키텍처

```
Frontend / IoT Device
       │
       ▼
[ Node.js API (Express) ]   ←→   [ Go Perun Node (gRPC/REST) ]
       │                                    │
       ├── Redis (hot state)                │
       ├── PostgreSQL (history/audit)       │
       └── Base L2 RPC (ethers.js)  ←──────┘
                                            │
                              [ Base L2 Smart Contracts ]
                              (Perun Adjudicator + AssetHolder)
```

## 채널 라이프사이클

```
open → [off-chain update × N] → close/settle → (dispute?)
  │                                   │
  └── Redis: 최신 상태               └── DB: 정산 TX 기록
```

## 환경설정

```bash
cp .env.example .env
# .env 파일 편집 후:
```

| 변수 | 설명 |
|---|---|
| `BASE_RPC_URL` | Base L2 RPC 엔드포인트 |
| `USDC_CONTRACT_ADDRESS` | Base 네이티브 USDC (`0x833589...`) |
| `OPERATOR_PRIVATE_KEY` | 운영자 서명 키 |
| `TREASURY_PRIVATE_KEY` | 강제 환불용 treasury 키 |
| `PERUN_GRPC_HOST/PORT` | Go Perun 노드 gRPC 주소 |
| `PERUN_ADJUDICATOR_ADDRESS` | Base에 배포된 adjudicator |
| `PERUN_ASSET_HOLDER_ADDRESS` | Base에 배포된 asset holder |

## 실행

```bash
# 개발
npm install
npm run dev

# Docker (권장)
docker compose up -d

# Watchtower 별도 실행
npm run watchtower
```

## API

### `POST /api/v1/channels/open`
채널 생성 + USDC 예치

```json
{
  "userAddress": "0xUser...",
  "depositUsdc": "100.0"
}
```

### `POST /api/v1/channels/:id/update`
오프체인 사용량 청구 (pay-per-use)

```json
{
  "chargeUsdc": "1.5",
  "userSig": "0x...",
  "userAddress": "0xUser..."
}
```

### `POST /api/v1/channels/:id/close`
세션 종료 + 온체인 정산

```json
{
  "userSig": "0x...",
  "userAddress": "0xUser...",
  "adjustment": { "creditUsdc": "0.5" }
}
```

### `POST /api/v1/channels/:id/refund`
환불 처리

```json
{
  "refundUsdc": "2.0",
  "refundType": "adjustment",
  "userAddress": "0xUser..."
}
```

`refundType`:
- `"adjustment"` — 오프체인 상태 업데이트로 크레딧 반영 (채널 열린 경우)
- `"forced"` — Treasury에서 직접 USDC 송금 (채널 종료 후 또는 대규모 보상)

### `GET /api/v1/channels/:id`
채널 상태 조회

### `GET /health`
서버 헬스체크 (Redis + DB 상태)

## Perun 노드 설정

Go Perun SDK는 별도 프로세스로 실행됩니다:

```bash
# go-perun 저장소 클론 후
git clone https://github.com/hyperledger-labs/go-perun
# gRPC 서버 구현체를 src/proto/perun.proto 기반으로 빌드
# 환경변수로 CHAIN_URL, ADJUDICATOR, ASSET_HOLDER 설정
```

현재 Node.js 백엔드는 gRPC 연결 실패 시 REST fallback을 사용합니다.

## 보안 체크리스트

- [x] 모든 상태 업데이트 시 nonce 순서 검증
- [x] 사용자 ECDSA 서명 검증 (ethers.js `verifyMessage`)
- [x] Rate limiting (기본 100 req/min)
- [x] Helmet (HTTP 보안 헤더)
- [x] Watchtower (분쟁 감지 + 자동 대응)
- [ ] API 인증 (JWT/HMAC) — 프로덕션 적용 필요
- [ ] Perun gRPC TLS 설정
- [ ] Treasury 키 HSM/KMS 이전
