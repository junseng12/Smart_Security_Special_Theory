# 사용량별 온체인 결제 비용 비교

두 방식 모두 로컬 Hardhat EVM과 소수점 6자리 MockUSDC로 측정했다. 기존 방식은 사용량 갱신마다 사용자에서 운영자로 0.1 USDC를 직접 전송한다. 제안 방식은 사용자와 운영자가 각각 3 USDC를 SmartCityEscrow에 예치하고, Go-Perun 공식 인코딩의 최종 증명으로 정산을 예약한 뒤 분쟁 기간 이후 청구한다. 이 스크립트는 n번의 실제 중간 Perun 업데이트를 실행하지 않고 최종 상태 버전과 누적 요금으로 나타낸다. 중간 업데이트의 온체인 TX 수는 0이다.

**제안 방식의 4 TX는 Perun 채널 개설·종료 TX가 아니다.** 사용자 예치(userDeposit), 운영자 예치(operatorDeposit), 정산 예약(settleAndRelease), 최종 청구(claimSettlement)라는 USDC 에스크로 호출이다. 현재 구현의 Perun 채널은 자금 배분이 0이므로 개설 시 온체인 예치를 건너뛰며, 정상 종료 시 Perun adjudicator 정산 TX도 보내지 않는다.

컨트랙트 배포·토큰 발행·approve는 두 방식의 준비 단계로 통계에서 제외했다. 기존 직접 전송 방식에는 에스크로·분쟁 보호가 없으므로 보안 수준까지 같은 프로토콜의 비교는 아니다. 각 n은 로컬 실험 1회이며, 별도의 Base Sepolia 제안 방식 벤치마크에는 실제 거래 10회가 있다.

수수료 열은 로컬 Gas × 0.006 gwei/Gas(기존 Base Sepolia 실험의 평균 가격)로 계산한 **L2 실행 수수료 추정치**다. 새로운 Base Sepolia 실거래 영수증이 아니며 L1 데이터 비용은 제외한다. 배포된 USDC와 MockUSDC의 Gas 사용량도 다를 수 있다.

| 사용량 갱신 횟수 | 직접 전송 TX | 직접 전송 Gas | 직접 전송 추정 수수료(ETH) | 제안 방식 TX | 제안 방식 Gas | 제안 방식 추정 수수료(ETH) |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 34484 | 0.000000206904 | 4 | 635926 | 0.000003815556 |
| 5 | 5 | 172420 | 0.00000103452 | 4 | 635986 | 0.000003815916 |
| 10 | 10 | 344840 | 0.00000206904 | 4 | 635986 | 0.000003815916 |
| 20 | 20 | 689680 | 0.00000413808 | 4 | 635962 | 0.000003815772 |

갱신 1회의 제안 방식 상세값:

| 에스크로 작업 | Gas |
|---|---:|
| userDeposit | 233927 |
| operatorDeposit | 71419 |
| settleAndRelease | 211270 |
| claimSettlement | 119310 |

모든 갱신 횟수별 작업 상세값은 [operations.csv](operations.csv), Base Sepolia의 실제 에스크로 거래 측정은 [gas-analysis.md](../gas-analysis/gas-analysis.md)를 참조한다.

같은 에스크로 ID(`0x28a2f57eff40d4e0663b387450130843eb939b2e3837f8de29436284854979bb`)의 Base Sepolia 거래 4건은 공개 RPC에서 함수·성공 여부·Gas를 재확인했다. **635,926 Gas는 위의 MockUSDC 로컬 합계이고, 다음 645,567 Gas는 실제 Base Sepolia 한 세션의 합계**다.

| 실제 Base Sepolia 작업 | 거래 | Gas |
|---|---|---:|
| 사용자 예치 | [거래 영수증](https://sepolia.basescan.org/tx/0xef0f5c1dcc1dbd84c115bb0f1d325f53d4c817b0bfe7f9ae33dbb09292eb5cf8) | 237,205 |
| 운영자 예치 | [거래 영수증](https://sepolia.basescan.org/tx/0xf1428981f5e4f859c73051e66436514b6b64d34807e97af8182440d6e01252d6) | 91,797 |
| 정산 예약 | [거래 영수증](https://sepolia.basescan.org/tx/0x1e87a7fc2a2aad9d57a95cecd7c82a86f454bc3b29ed5e7ed07f351a2487dd39) | 211,918 |
| 최종 청구 | [거래 영수증](https://sepolia.basescan.org/tx/0xcef365a6266cb592eed7580740dbce8485c6c72c96a546b66003546d43d94187) | 104,647 |
| **실거래 합계** | **성공 거래 4건** | **645,567** |

`userDeposit`은 새로운 에스크로 기록의 사용자·운영자·예치금·마감 시각·상태를 저장하고 Perun 채널 ID와 채널 재사용 표시를 새로 기록한다. 비어 있던 에스크로 주소로 USDC를 처음 옮기며 이벤트 2개도 남긴다. `operatorDeposit`은 이미 존재하는 기록의 운영자 예치금·상태를 갱신하고 USDC를 한 번 옮기며 이벤트 1개를 남긴다. 따라서 두 함수의 Gas는 같지 않다. 정확한 세부 Gas 비중은 토큰 구현과 저장 상태에 따라 달라진다. 전체 합계는 한 사람이 한 거래에서 지불한 Gas가 아니라 사용자 예치 거래와 운영자 측 정산 거래들을 합친 네 거래의 사용량이다.

재현 명령: `cd smartcontract; npx.cmd hardhat run scripts/compare-payment-costs.js --network hardhat`. Node 의존성과 Go가 필요하다.
