# SmartCity payment backend

이 서비스는 결제 금액을 결정하지 않고 Go-Perun과 `SmartCityEscrow` 사이를 연결한다.

현재 정산 흐름은 다음과 같다.

1. 사용자의 USDC는 `SmartCityEscrow`에 예치된다.
2. Go-Perun이 1분마다 누적 요금을 `State.appData`에 넣고 두 Perun 참가자의 native signature를 생성한다.
3. 종료 시 Go 노드가 Params ABI, State ABI, signatures를 반환한다.
4. 백엔드는 이 증명을 그대로 `SmartCityEscrow.settleAndRelease`에 전달한다.
5. 컨트랙트가 증명과 appData를 검증하고 fare를 추출한다.
6. dispute window가 끝나면 메인 백엔드 스케줄러가 `claimSettlement`을 실행한다.

백엔드는 요청의 `fareUsdc`로 정산하지 않는다. 컨트랙트 소스의 단일 기준은 [`../smartcontract/SmartCityEscrow.sol`](../smartcontract/SmartCityEscrow.sol)이다.

## 실행

```bash
npm ci
npm test
npm start
```

테스트는 Jest가 선택하는 `*.unit.test.js`와 `escrowSchema.integration.test.js`로 구성된다. Go와 컨트랙트 테스트는 각각 `../go-perun-node`와 `../smartcontract`에서 실행한다.

## 주요 구성

- `src/routes/sessions.js`: 세션 생성, 예치 확인, 종료, 상태 조회
- `src/services/usageBillingService.js`: 1분 단위 과금과 종료 동기화
- `src/services/channelOrchestrator.js`: Go-Perun gRPC 호출과 감사 기록
- `src/services/escrowPayoutService.js`: 증명 relay와 claim/refund 트랜잭션
- `src/services/chainTransactionTracker.js`: 영수증·온체인 상태 검증과 최종 DB 반영
- `src/index.js`: API 서버와 단일 recovery/claim 스케줄러

레거시 메모리 채널 API, 브라우저 서명 제출 API, 별도 watchtower, 별도 cron endpoint, 백엔드 내부 컨트랙트 복사본과 배포 스크립트는 제거됐다.

운영 변수와 외부 검증 순서는 [RUNBOOK.md](RUNBOOK.md)를 참고한다.
