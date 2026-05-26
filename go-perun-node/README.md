# SmartCity Go-Perun Node

hyperledger-labs/go-perun SDK를 기반으로 구현한 SmartCity 오프체인 결제 노드입니다.

## 아키텍처

```
Node.js Backend (Railway)
    └── perunClient.js
          └── gRPC (port 50051)
                ↓
    Go-Perun Node (이 서비스)
          ├── transport/server.go    ← gRPC 서버
          ├── channel/orchestrator.go ← 비즈니스 로직 포장지
          ├── channel/channel.go     ← go-perun SDK 직접 호출
          ├── session/session.go     ← 세션 생명주기
          ├── pricing/pricing.go     ← 요금 계산 엔진
          ├── refund/refund.go       ← 환불 처리
          └── audit/audit.go        ← 감사 로그
                ↓
    go-perun SDK (hyperledger-labs/go-perun)
          ├── client.ProposeChannel()  ← 채널 개설
          ├── ch.Update()             ← 오프체인 상태 업데이트
          ├── ch.Settle()             ← 온체인 정산
          ├── ch.Watch()             ← 분쟁 자동 감지
          └── ch.ForceUpdate()       ← 수동 분쟁 트리거
                ↓
    Base Sepolia (L2)
          ├── Perun Adjudicator       ← 분쟁/정산 중재
          └── ERC20 AssetHolder       ← USDC 예치/출금
```

## 백엔드 함수 ↔ go-perun API 매핑

| 우리 함수 | go-perun API | 역할 |
|---|---|---|
| `startSession()` | - | 세션 DB 생성 |
| `openChannel()` | `client.ProposeChannel()` | 채널 개설 + USDC 예치 |
| `proposeUsageUpdate()` | `ch.Update(transferBalance)` | ★ 진짜 오프체인 마이크로페이먼트 |
| `finalUpdateAndAdjust()` | `ch.Update(IsFinal=true)` | credit 반영 + 채널 최종화 |
| `endSession()` / `closeChannel()` | `ch.Settle()` | 온체인 출금 |
| `initiateDispute()` | `ch.ForceUpdate()` | 수동 분쟁 트리거 |
| (자동) | `ch.Watch(handler)` | 분쟁 자동 감지 & 대응 |
| `accumulateRefundCredit()` | - (누적만) | 정산 전 환불 credit |
| `postSettlementCompensation()` | Treasury.SendUsdc() | 정산 후 USDC 송금 |
| `emitEvent()` | gRPC StreamEvents | SSE 대체 |
| `auditLog()` | AuditLogger.Log() | 감사 로그 |

## 빌드 & 실행

```bash
# proto 컴파일 (최초 1회)
cd go-perun-node
protoc --go_out=. --go-grpc_out=. proto/smartcity.proto

# 의존성 설치
go mod tidy

# 실행 (mock 모드)
go run cmd/main.go

# 실행 (실제 Base Sepolia 연결)
export BASE_RPC_URL=https://sepolia.base.org
export OPERATOR_PRIVKEY=<your_private_key>
export ADJUDICATOR_ADDR=<perun_adjudicator_address>
export ASSET_HOLDER_ADDR=<usdc_asset_holder_address>
export GRPC_PORT=50051
go run cmd/main.go
```

## Node.js 연동

`perunClient.js`에서 환경변수 설정:
```
PERUN_GRPC_HOST=localhost
PERUN_GRPC_PORT=50051
```

그러면 `useGrpc=true` 모드로 전환되어 이 Go 노드를 호출합니다.

## 현재 구현 상태

- [x] 전체 패키지 구조 및 인터페이스
- [x] gRPC 서비스 정의 (proto/smartcity.proto)
- [x] 세션 관리 (session.Manager)
- [x] 요금 계산 엔진 (pricing.Engine)
- [x] 환불 관리 (refund.Manager)
- [x] 감사 로그 (audit.Logger)
- [x] Orchestrator (비즈니스 로직 포장지)
- [x] go-perun 채널 함수 뼈대 (channel.Manager)
- [x] gRPC 서버 (transport.GRPCServer)
- [ ] go-perun ETH 백엔드 실제 연결 (initPerunClient 구현)
- [ ] proto 컴파일 (protoc 실행)
- [ ] PostgreSQL 실제 store 구현
- [ ] libp2p P2P 통신 (UserWireAddr 교환)
