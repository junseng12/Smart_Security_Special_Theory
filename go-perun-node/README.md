# SmartCity Go-Perun Node

hyperledger-labs/go-perun + perun-eth-backend 기반 오프체인 결제 노드

## 저장소 역할 요약

| 저장소 | 역할 | 우리 코드에서의 위치 |
|---|---|---|
| `hyperledger-labs/go-perun` | 설계도 (인터페이스) | go.mod require (간접 의존) |
| `hyperledger-labs/perun-eth-backend` | **ETH 구현체** (실제 사용) | `internal/setup/setup.go` import |
| `hyperledger-labs/perun-eth-contracts` | Solidity 컨트랙트 | Base Sepolia 배포 |

## 아키텍처

```
Node.js (Railway)
  └── perunClient.js ──gRPC──▶ transport/server.go
                                    │
                              channel/orchestrator.go
                               ├── channel/channel.go
                               │     └── go-perun ch.Update() / ch.Settle()
                               │           └── perun-eth-backend
                               │                 ├── ERC20Depositor (approve+deposit)
                               │                 └── Adjudicator (register+withdraw)
                               ├── session/session.go
                               ├── pricing/pricing.go
                               ├── refund/refund.go
                               └── audit/audit.go
                                         │
                               setup/setup.go  ◀── 유일한 초기화 지점
                                 ├── swallet.NewWallet(privKey)
                                 ├── ethchannel.NewFunder(cb)
                                 │     └── ERC20Depositor.Deposit()
                                 │           ├── USDC.approve() TX ①
                                 │           └── AssetHolder.deposit() TX ②
                                 ├── ethchannel.NewAdjudicator(cb, adjAddr, receiver)
                                 │     └── Adjudicator.Withdraw() → AssetHolder TX
                                 ├── local.NewWatcher(adj)  ← 분쟁 자동 감지
                                 └── client.New(bus, funder, adj, wallet, watcher)
                                           ▲
                             Base Sepolia (perun-eth-contracts)
                               ├── Adjudicator.sol
                               └── AssetHolderERC20.sol
```

## 빠른 시작

### 1. perun-eth-contracts 배포 (최초 1회)
```bash
cd go-perun-node
export BASE_RPC_URL=https://sepolia.base.org
export OPERATOR_PRIVKEY=<hex_key>
export USDC_TOKEN_ADDR=0x036CbD53842c5426634e7929541eC2318f3dCF7e
go run contracts/scripts/deploy.go
# → ADJUDICATOR_ADDR, ASSET_HOLDER_ADDR 출력됨
```

### 2. Railway 환경변수 등록
```
BASE_RPC_URL=https://sepolia.base.org
CHAIN_ID=84532
OPERATOR_PRIVKEY=<hex_key>
ADJUDICATOR_ADDR=<배포된 주소>
ASSET_HOLDER_ADDR=<배포된 주소>
USDC_TOKEN_ADDR=0x036CbD53842c5426634e7929541eC2318f3dCF7e
RECEIVER_ADDR=<운영자 수령 주소>
GRPC_PORT=50051
```

### 3. proto 컴파일
```bash
cd go-perun-node
protoc --go_out=. --go-grpc_out=. proto/smartcity.proto
```

### 4. 실행
```bash
go mod tidy
go run cmd/main.go
```

## 백엔드 함수 → perun-eth-backend API 매핑

| 함수 | perun-eth-backend API | 온체인 TX |
|---|---|---|
| `OpenChannel` | `ERC20Depositor.Deposit()` | approve ① + deposit ② |
| `ChargeUsage` | `ch.Update(TransferBalance)` | **없음 (오프체인)** |
| `FinalUpdateAndAdjust` | `ch.Update(IsFinal=true)` | **없음 (오프체인)** |
| `CloseChannel` | `Adjudicator.Withdraw()` | withdraw TX |
| `InitiateDispute` | `ch.ForceUpdate()` → `Adjudicator.Register()` | register TX |
| (자동) `Watch` | `local.Watcher` | 분쟁 시 register TX 자동 |
