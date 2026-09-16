# SmartCity Go-Perun node

Go-Perun v0.15.0과 perun-eth-backend v0.6.0을 사용해 서비스 이용 상태를 서명한다.

실제 USDC는 `SmartCityEscrow`가 보관한다. Perun AssetHolder의 잔액은 의도적으로 0이며 `ZeroSkippingFunder`가 전액 0인 funding request를 즉시 완료한다. Perun 채널은 다음 데이터만 담당한다.

- `PaymentData`가 포함된 `State.appData`
- 1분 단위 누적 fare와 nonce
- final Params ABI와 State ABI
- 두 Perun 참가자의 native signatures

`internal/paymentapp/proof.go`는 perun-eth-backend의 `ToEthParams`, `EncodeParams`, `ToEthState`, `EncodeState`, `HashState`를 사용한다. 자체 ABI나 서명 형식을 만들지 않는다.

## 필수 환경 변수

- `BASE_RPC_URL`
- `CHAIN_ID=84532`
- `OPERATOR_PRIVKEY`
- `ADJUDICATOR_ADDR`
- `ASSET_HOLDER_ADDR`
- `USDC_TOKEN_ADDR`
- `RECEIVER_ADDR`
- `ESCROW_CONTRACT_ADDRESS`
- `PERUN_PERSISTENCE_PATH`
- `GRPC_PORT=50051`

`PERUN_PERSISTENCE_PATH`는 Railway volume 내부 경로를 사용한다. 이 저장소는 재시작 복구용이며 새 컨트랙트 배포와 관계없다.

## 검증

```bash
go test ./...
```

실제 컨트랙트와 ABI 호환성은 `../smartcontract/test/stateBoundSettlement.test.js`가 `cmd/perun-proof-fixture`의 공식 Perun encoding/signature 결과를 받아 검증한다.
