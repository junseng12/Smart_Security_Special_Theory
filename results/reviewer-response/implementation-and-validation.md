# 리뷰 대응: 실제 구현과 검증 범위

기준: `go-sdk` 연구용 구현. 비용 비교는 로컬 Hardhat 실험이다. 기존 [Base Sepolia 에스크로 측정](../gas-analysis/gas-analysis.md) 및 [종단 간 검증](../e2e-validation/table3-e2e-scenarios.md)은 별도 자료다. 이번 리뷰 대응에서 Base Sepolia 거래나 새 컨트랙트 배포는 하지 않았다.

## 1. 구현된 결제 구조

1. 백엔드는 DB 세션 ID와 `keccak256(utf8(세션 ID))`로 만든 에스크로 ID를 Go 노드에 전달한다([channelOrchestrator.js](../../smartcity-payment-backend/src/services/channelOrchestrator.js)의 `startSessionAndOpenChannel`, [orchestrator.go](../../go-perun-node/internal/channel/orchestrator.go)의 `StartSessionAndOpen`).
2. Go는 양쪽 자금 배분이 0인 Perun 채널을 연다. 두 번째 참가자는 MetaMask 사용자가 아니라 서버가 생성한 보관형 참가자다. 실제 USDC는 `SmartCityEscrow.userDeposit`과 `operatorDeposit`으로 예치한다([channel.go](../../go-perun-node/internal/channel/channel.go)의 `OpenChannel`, [SmartCityEscrow.sol](../../smartcontract/SmartCityEscrow.sol)). **현재 Perun 채널 개설은 온체인 예치 TX를 만들지 않는다.**
3. 백엔드는 경과한 1분 단위로 청구를 실행하고 Go의 `ChargeUsage`가 Perun appData 요금과 상태 버전·해시를 갱신한다([usageBillingService.js](../../smartcity-payment-backend/src/services/usageBillingService.js), [channel.go](../../go-perun-node/internal/channel/channel.go)). 이 경로에 인증된 실물 기기 텔레메트리 연결은 확인되지 않았다.
4. 종료 시 백엔드는 청구를 중단한다. Go는 최종 상태와 두 Perun 참가자의 서명을 공식 형식으로 내보내고, 백엔드는 이를 에스크로에 전달한다([proof.go](../../go-perun-node/internal/paymentapp/proof.go)의 `Export`). `settleAndRelease`는 요금을 예약하고, 실제 4분 분쟁 기간이 지난 뒤 `claimSettlement`가 USDC를 분배한다. **현재 정상 종료 시 Perun adjudicator를 통한 `ch.Settle()` 거래는 없다.**

## 2. 비용 비교: 무엇을 합산했는가

직접 결제 방식은 매 사용량 갱신마다 MockUSDC를 사용자에서 운영자로 전송한다. 제안 방식의 네 거래는 **Perun 채널 개설·종료 거래가 아니라** 다음의 에스크로 거래다.

| 에스크로 작업 | 함수 | 갱신 1회 실험의 Gas |
|---|---|---:|
| 사용자 예치 | `userDeposit` | 205,188 |
| 운영자 예치 | `operatorDeposit` | 71,443 |
| 최종 증명 검증과 정산 예약 | `settleAndRelease` | 139,866 |
| 분쟁 기간 후 실제 분배 | `claimSettlement` | 120,469 |
| **제안 방식 합계** | **4개 TX** | **536,966** |

두 방식 모두 같은 로컬 Hardhat EVM과 소수점 6자리 MockUSDC를 사용했다. 제안 방식은 저장 공간과 정산 호출을 최적화한 현재 `SmartCityEscrow.sol` 소스로 측정했다. 컨트랙트 배포·발행은 준비 단계로 제외했고, 제안 방식에 필요한 USDC `approve` 거래도 제외했다. 직접 전송에는 `approve`가 필요하지 않으므로 아래 교차점은 **사전 승인이 완료된 경우의 실행 Gas** 기준이다. 중간 Perun 갱신은 최종 증명의 버전과 누적 요금으로 나타냈고, 이 비용 스크립트에서 실제 n번의 채널 갱신을 실행하지는 않았다. 따라서 이 표는 온체인 실행 비용 비교이며 상태 채널 처리량 측정이 아니다. 각 갱신 횟수는 로컬 1회 실행했다.

| 사용량 갱신 횟수 | 직접 전송 TX | 직접 전송 Gas | 직접 전송 추정 L2 실행 수수료(ETH) | 제안 방식 TX | 제안 방식 Gas | 제안 방식 추정 L2 실행 수수료(ETH) |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 34,484 | 0.000000206904 | 4 | 536,966 | 0.000003221796 |
| 5 | 5 | 172,420 | 0.000001034520 | 4 | 537,026 | 0.000003222156 |
| 10 | 10 | 344,840 | 0.000002069040 | 4 | 537,026 | 0.000003222156 |
| 15 | 15 | 517,260 | 0.000003103560 | 4 | 537,026 | 0.000003222156 |
| 16 | 16 | 551,744 | 0.000003310464 | 4 | 537,014 | 0.000003222084 |
| 20 | 20 | 689,680 | 0.000004138080 | 4 | 537,002 | 0.000003222012 |

수수료는 로컬 측정 Gas에 기존 Base Sepolia 실험의 평균 유효 가격인 **0.006 gwei/Gas**를 곱한 추정치다. 새 Base Sepolia 실거래 수수료가 아니며 Base의 L1 데이터 비용을 포함하지 않는다. 실제 USDC와 MockUSDC의 Gas도 다를 수 있다. 분당 1회 온체인 직접 전송을 가정하면 **15회까지는 직접 전송, 16회째(16분)부터는 제안 방식의 누적 Gas가 더 낮다**. 20회에는 직접 전송 689,680 Gas 대비 제안 방식 537,002 Gas로 약 **22.1% 절감**된다. 직접 전송 방식에는 제안 방식의 에스크로·분쟁 보장이 없다. 최적화된 컨트랙트는 아직 Base Sepolia에 배포하지 않았다. [합계 CSV](../payment-cost-comparison/comparison.csv), [작업별 CSV](../payment-cost-comparison/operations.csv), [재현 스크립트](../../smartcontract/scripts/compare-payment-costs.js)에 근거값이 있다.

## 3. 위협별 실제 결과

[컨트랙트 테스트](../../smartcontract/test/stateBoundSettlement.test.js) 12개가 통과했다.

| 위협 | 시도 주체 | 시도 | 기대한 방어 | 실제 결과 |
|---|---|---|---|---|
| T1 변조·비최종 상태 | 사용자 또는 제공자 | appData 변조, 최종 플래그 누락, 다른 채널 증명 | 정산 거부 및 USDC 보존 | `InvalidPerunProof`로 거부, 잔액과 상태 유지 |
| T2 과거 상태·재사용 | 두 서명 키에 접근하는 제공자 | 이전 비최종 상태 제출; 별도로 상충하는 버전 3·4 최종 증명을 만들어 버전 3부터 제출 | 이전 상태 배제 | 비최종 상태·중복 정산은 거부. **상충하는 과거 최종 증명은 버전 4가 체인 밖에만 있으면 수락됨** |
| T3 다른 정산 금액 | 사용자 또는 제공자 | 증명의 appData 요금만 바꾸기 | 다른 금액 거부 | 서명 불일치로 거부, USDC 이동 없음. 별도의 임의 요금 입력 인자는 없음 |
| T4 조기 청구 | 제공자 | 4분 경과 전 청구 | 청구 거부 | `ClaimPeriodNotEnded`, USDC 이동 없음 |
| T5 무단 환불 | 권한 없는 사용자 | 직접 이슈 등록 또는 이슈 없는 환불 | 환불 거부 | 둘 다 거부. 단, 권한 있는 운영자는 온체인 기기 증거 없이 이슈를 등록할 수 있음 |

정상적인 Go-Perun 경로에서는 최종 상태가 된 뒤 추가 갱신을 받지 않는다. 그보다 앞선 일반 상태는 비최종이므로 T2에서 거부된다. 상충하는 최종 증명 테스트는 **서명 키의 이중 서명**을 가정한다. 서버가 운영자와 보관형 참가자의 서명 키를 통제할 수 있으므로, 악의적인 제공자를 위협 모델에 넣는다면 이 가능성을 배제할 수 없다.

Perun의 표준 adjudicator 분쟁 경로에서는 등록된 상태를 **분쟁 기간 안에 더 높은 버전의 상태로 반박**할 수 있다([Perun Ethereum 컨트랙트 설명](https://github.com/hyperledger-labs/perun-eth-contracts#dispute)). 판정자가 체인 밖의 최신 상태를 스스로 찾아내는 것은 아니므로, 최신 상태를 가진 참가자가 기간 안에 제출해야 한다. 현재 두 번째 참가자는 서버가 만든 보관형 계정이라는 제약도 있다. 또한 `channel.go`의 `InitiateDispute`는 오류만 반환하며, `CloseChannel`도 `ch.Settle()`을 호출하지 않는다. SmartCityEscrow는 adjudicator에 등록된 상태를 조회하거나 그 판정 결과를 정산 조건으로 사용하지 않는다. 따라서 **Perun 자체의 가능한 반박 절차가 현재 USDC 에스크로의 T2 방어로 자동 연결되지는 않는다.** 연결하려면 adjudicator 사용, 독립적으로 이의를 제기할 참가자, 기간, 에스크로가 판정 결과를 확인하는 방법을 함께 설계하고 재측정해야 한다.

## 4. 최종 상태 검증 절차

| 단계 | 파일·함수 | 실제 검사 |
|---|---|---|
| 최종 증명 내보내기 | `go-perun-node/internal/channel/channel.go`의 `ExportFinal`, `internal/paymentapp/proof.go`의 `Export` | 저장 채널 복원, `CurrentTX()`, `IsFinal`, 채널 ID, 두 원본 서명 검증, 공식 Params·State 인코딩 |
| 증명 전달 | `smartcity-payment-backend/src/services/channelOrchestrator.js`의 `endSessionAndSettle`, `escrowPayoutService.js`의 `settleAndReleaseInternal` | 청구 중단, 증명 형식 검사, `verifiedFare` 호출; 별도의 요금 인자를 정산 함수에 주지 않음 |
| 채널·상태 검사 | `smartcontract/SmartCityEscrow.sol`의 `verifiedFare` | ABI 정규 인코딩, 예치 시 결속한 채널 ID, 컨트랙트 주소, ledger·non-virtual 플래그, 최종 플래그, `version > 0` |
| 서명 검사 | 같은 함수 | 서로 다른 참가자 주소 2개, 저장된 운영자 주소, 두 Ethereum 서명 복원값 검사. 두 번째는 MetaMask 주소가 아니라 보관형 참가자 주소 |
| 요금 결속 검사 | 같은 함수 | 한 자산·두 명의 0잔액 Perun 배분, appData의 에스크로 ID·체인 ID·계약 주소·저장된 MetaMask 사용자·예치금·요금 상한 검사 |
| 정산 예약 | `settleAndRelease` | 운영자 권한, `FullyFunded`, 예치 마감 시각 경과 후 검증된 요금 저장; 상태 해시·버전 이벤트 기록 |
| 최종 분배 | `claimSettlement` | `Released`, 미청구, `claimableAfter` 경과 확인 후 USDC 전송 |

컨트랙트가 기록하는 상태 해시·버전은 **감사 기록**이지 별도로 저장된 최신 최종 해시·버전과의 비교가 아니다. 채널 ID는 예치 시 정한 채널의 동일성을 확인한다. Params의 nonce는 채널 ID에 반영되지만 최신 상태 버전을 나타내지 않는다. 요금도 증명 검증 **후** 저장하므로 사전에 독립적으로 확정된 예상 요금과 비교하지 않는다.

## 5. 장애 판단과 환불 절차

현재 구현에는 인증된 실물 기기 상태가 백엔드에 자동 보고되고 장애가 자동 확정되는 전체 경로가 없다. 정상 과금은 시간 기반 스케줄러에서 시작한다. 장애 사례는 [환불 API](../../smartcity-payment-backend/src/routes/refunds.js)의 사유 및 선택적 증거 제출, 규칙 평가 또는 수동 검토로 시작한다.

[환불 판단 코드](../../smartcity-payment-backend/src/services/refundDecisionEngine.js)는 `sensor_failure`에 제출된 반납·종료 기록과 요금 기록을 요구한다. `double_charge`는 DB nonce 중복을 조회한다. `unlock_failure`는 독립 증거 확인 없이 자동 승인 대상이며, `service_outage`는 장애 기록 없이도 승인할 수 있다. `device_fault`와 `wrong_charge`는 수동 검토 대상이다. 조건에 해당하는 5 USDC 이하 사례는 자동 승인한다. 이 규칙은 **신뢰하는 백엔드의 정책**이지 기기 증거의 온체인 검증이 아니다.

지급 API는 `APPROVED` 상태와 사례·세션 사용자 일치를 확인한다. [escrowPayoutService.js](../../smartcity-payment-backend/src/services/escrowPayoutService.js)의 `refundToBuyer`는 운영자 지갑으로 `RefundIssue`를 등록하고 요금 인자 0을 전달해 사용자 예치금 전액을 환불한다. 승인된 사례의 금액을 부분 환불액으로 온체인에 전달하지 않는다. 컨트랙트는 운영자 권한, 에스크로 상태, 이슈 존재, 예약 후 분쟁 기간을 검사하지만 기기 증거와 사례 판단 자체는 검사하지 않는다. 환불 라우트에서 콘텐츠 형식·입력값 검사 이상의 인증 미들웨어는 확인되지 않았다.

별도로 최종 Perun 증명이 예치 마감 후 1시간 동안 없으면 [index.js](../../smartcity-payment-backend/src/index.js)와 [settlementRecovery.js](../../smartcity-payment-backend/src/services/settlementRecovery.js)가 `forceRefund`를 실행한다. 이는 기기 장애 탐지가 아니라 증명 생성 실패 복구다.

## 6. 논문에 사용할 수 있는 문단

**비용:** 같은 로컬 EVM과 ERC-20 모의 토큰으로 사용량 갱신마다 직접 결제하는 방식과 제안 방식을 비교하였다. 직접 결제 방식의 온체인 거래 수는 갱신 횟수에 비례하지만, 제안 방식의 온체인 거래는 사용자·운영자 예치, 최종 증명 검증과 정산 예약, 분쟁 기간 후 청구의 4건으로 일정하였다. 사전 `approve` 비용을 제외한 1회 갱신 기준 제안 방식은 536,966 Gas였으며, 분당 1회 직접 전송하는 조건에서는 16회째부터 누적 Gas가 더 낮았다. 20회에서는 직접 전송 689,680 Gas와 제안 방식 537,002 Gas로 약 22.1% 절감되었다. 이 값은 최적화된 컨트랙트의 로컬 MockUSDC 측정 결과로, 실제 USDC와 Base Sepolia에서의 절감률은 별도 검증이 필요하다. 직접 전송에는 제안 방식의 에스크로·분쟁 보장이 없다.

**보안:** SmartCityEscrow는 예치된 채널 ID와 최종 플래그, 두 Perun 서명, 체인·계약·세션·사용자·예치금에 결속된 appData를 검증한 뒤 그 안의 요금만 예약한다. 정상적인 Go-Perun 갱신 경로의 과거 상태는 비최종이므로 정산에 사용할 수 없다. 다만 두 서명 키로 상충하는 최종 증명을 만든 경우 현재 에스크로는 체인 밖의 더 최신 버전을 알 수 없으며, Perun adjudicator의 판정 결과도 에스크로 정산에 연결되어 있지 않다.

**장애·환불:** 현재 장애 및 과금 오류 판단은 신뢰하는 백엔드의 환불 사례 접수, 정책 평가와 수동 검토를 통해 수행된다. 승인된 사례에 대해 운영자 권한으로 `RefundIssue`를 등록하고 사용자 예치금을 환불한다. 기기 텔레메트리의 독립 인증과 자동 장애 탐지는 구현되어 있지 않다.

## 7. 재현 명령과 변경 파일

Windows PowerShell의 저장소 루트에서 실행한다.

```powershell
cd smartcontract
npm.cmd test
npx.cmd hardhat run scripts/compare-payment-costs.js --network hardhat
cd ..\smartcity-payment-backend
npm.cmd test
cd ..\go-perun-node
go test ./...
```

| 파일 | 변경 목적 |
|---|---|
| `smartcontract/SmartCityEscrow.sol` | 중복 정산 금액 저장 제거, 기한 저장 공간 압축, 중복 이벤트 제거, 운영자 송금 합치기 |
| `smartcontract/scripts/compare-payment-costs.js` | 최적화된 에스크로와 직접 전송의 로컬 Gas·수수료를 15·16회 구간까지 측정 |
| `results/payment-cost-comparison/comparison.csv`, `operations.csv`, `comparison.md` | 합계·작업별 값과 논문용 표 저장 |
| `smartcontract/test/stateBoundSettlement.test.js` | T1~T5의 방어와 T2 한계, 청구·환불·긴급 취소 검증 |
| `smartcity-payment-backend/src/services/db.js` | 실제 4분 분쟁 기간과 주석 일치 |
| `go-perun-node/internal/channel/channel.go` | 실제 채널 개설·종료 및 분쟁 경로에 맞게 설명 주석 정정 |
| 이 문서 | 측정 범위, 보장·비보장 항목, 신뢰 가정과 논문 문안 정리 |

비용 스크립트에는 로컬 Node 의존성과 Go가 필요하다. Base RPC, 개인키, MetaMask는 필요하지 않다. 실제 Base Sepolia 직접 결제 비교는 별도의 지갑 자금과 네트워크 설정이 있어야 하며 이번 실행에는 포함되지 않았다.
