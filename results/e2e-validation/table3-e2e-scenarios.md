# Table 3. 종단 간 검증 시나리오 및 결과

## 논문 표 삽입용

| 시나리오 | 검증 대상 | 주요 확인 항목 | 결과 |
|---|---|---|---|
| 정상 서비스 및 정산 | 사용량 기반 Perun 상태 갱신과 최종 USDC 정산 | Perun state version 및 state hash 갱신, `SettlementReserved`·`SettlementClaimed` 트랜잭션, 사용자·운영자 USDC 잔액 변화 | **성공(10/10)**. 모든 세션에서 Perun state version이 4까지 증가하고 state hash가 기록되었다. 최종 fare는 0.4 USDC였으며, 10건 모두 정산 예약과 claim을 완료하고 `settlementClaimed=true`가 되었다. 대표 세션의 claim 블록 전후 잔액은 사용자 +2.6 USDC, 운영자 +3.4 USDC로 확인되었다. |
| 서비스 장애 및 환불 | 잠금 해제 실패 모의 장애 후 RefundIssue 전환과 전액 환불 | `RefundIssueRegistered`·`RefundedToBuyer` 트랜잭션, 최종 `Refunded` 상태, 사용자·운영자 USDC 잔액 변화 | **성공(10/10)**. 10건 모두 `unlock_failure` 환불 정책을 거쳐 최종 `Refunded` 상태가 되었고 사용자 환불액은 3.0 USDC였다. 대표 세션의 환불 블록 전후 잔액은 사용자 +3.0 USDC, 운영자 +3.0 USDC로 확인되었다. |
| 비정상 정산 요청 | 최종 Perun 상태와 불일치하는 proof 및 non-final state 차단 | `InvalidPerunProof` revert, 정산 상태 불변, 사용자·운영자·escrow USDC 잔액 불변 | **성공(2/2)**. 변조된 Params/State 조합과 `isFinal=false` 상태를 사용한 `settleAndRelease`가 모두 `InvalidPerunProof`로 거부되었다. 거부 후 escrow 상태는 `FullyFunded`로 유지됐고 세 주소의 USDC 잔액도 변하지 않았다. |

## 대표 검증 근거

### 정상 서비스 및 정산

- 검증 세션: `d815a8a8-a352-4822-ac2a-15660bc631a1`
- Perun channel ID: `0x87e496123cfdaebaf4ce0c7127a782832b101ef3721823c69f564d146ec889be`
- 최종 state version: `4`
- 최종 state hash: `0x898a0c380c00b4aaea533fa973a0f92ac13f0579fcf0a0ff296c5db2345cfb39`
- 최종 fare: `0.400000 USDC`
- 사용자 환급: `2.600000 USDC`
- claim 트랜잭션: `0xcef365a6266cb592eed7580740dbce8485c6c72c96a546b66003546d43d94187`
- 최종 상태: `COMPLETED`, `Released`, `settlementClaimed=true`
- claim 블록 `46881652` 전후 실제 USDC 잔액 변화: 사용자 `+2.6`, 운영자 `+3.4`

### 서비스 장애 및 환불

- 검증 세션: `4950a258-3967-44b7-a5eb-803fb7c4d5d7`
- 장애 유형: `unlock_failure`
- 사용자 환불: `3.000000 USDC`
- 환불 트랜잭션: `0x3c43cc0c0bb0d4dd61a52f1681dac31a3a10f12656e523f01275578d4ee4e7c6`
- 최종 상태: `REFUNDED`, `Refunded`
- 환불 블록 `46882017` 전후 실제 USDC 잔액 변화: 사용자 `+3.0`, 운영자 `+3.0`

### 비정상 정산 요청

- 공식 Go-Perun proof fixture로 생성한 Params ABI, State ABI 및 native signatures를 사용했다.
- 서명된 최종 상태와 일치하지 않는 Params/State 조합을 제출했을 때 `InvalidPerunProof`가 발생했다.
- `isFinal=false`인 상태를 제출했을 때도 `InvalidPerunProof`가 발생했다.
- 두 경우 모두 `settleAndRelease`가 실행되지 않았고 escrow 상태와 USDC 잔액이 유지됐다.

## 논문 결과 문단 삽입용

정상 서비스 및 정산 시나리오는 Base Sepolia에서 10회 수행하였으며 모든 세션이 성공적으로 완료되었다. 각 세션에서는 사용량 과금에 따라 Perun state version이 4까지 증가하고 상태 해시가 기록되었으며, 최종 상태의 appData에 포함된 0.4 USDC가 SmartCityEscrow에 의해 검증되었다. 이후 `SettlementReserved`와 `SettlementClaimed`가 순서대로 실행되었고, 최종적으로 사용자에게 2.6 USDC가 반환되고 운영자에게 fare 0.4 USDC와 운영자 예치금 3 USDC가 지급되었다.

서비스 장애 및 환불 시나리오 역시 10회 모두 성공하였다. 잠금 해제 실패를 모의한 `unlock_failure` 환불 요청이 등록된 후 escrow가 `RefundIssue`를 거쳐 `Refunded` 상태로 전환되었으며, 사용자의 예치금 3 USDC와 운영자의 예치금 3 USDC가 각각 원래 소유자에게 반환되었다. 비정상 정산 검증에서는 최종 Perun 상태와 일치하지 않는 proof 및 final 표시가 없는 상태를 제출하였고, 두 요청 모두 `InvalidPerunProof`로 거부되었다. 거부 전후 escrow 상태와 USDC 잔액은 변하지 않았다.

## 검증 범위 주의사항

- 정상·환불 20건은 벤치마크 클라이언트가 Backend API를 호출하고 이후 Go-Perun 및 Base Sepolia까지 연결한 실제 E2E 결과다. 브라우저 UI 클릭과 MetaMask 팝업 자체는 이 자동 반복 시험에 포함되지 않았다.
- 서비스 장애는 물리 기기의 실제 고장이 아니라 `unlock_failure` 정책 입력으로 모의했다.
- 비정상 정산은 배포 컨트랙트와 동일한 코드를 대상으로 한 Hardhat 통합 시험이다. 실패가 예상되는 트랜잭션을 Base Sepolia에 반복 전송해 test ETH를 소비하지는 않았다.
