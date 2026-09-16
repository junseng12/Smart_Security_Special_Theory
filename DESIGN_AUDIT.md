# State-bound settlement 설계 점검

기준 커밋은 `960abf5054fba70f0899a96450b8dc92712123f3`, 작업 브랜치는 `go-sdk`다.

## 설계와 일치하는 부분

- 실제 USDC는 `SmartCityEscrow`에만 보관된다.
- Perun AssetHolder allocation은 양 참가자 모두 0이고 `ZeroSkippingFunder`가 온체인 funding을 생략한다.
- canonical escrow ID는 `keccak256(UTF-8 DB session ID)`다.
- fare와 escrow/user/chain/deposit 도메인은 `PaymentData`와 최종 `State.appData`에 포함된다.
- proof는 공식 perun-eth-backend ABI 변환·encoding·hash와 native signatures를 사용한다.
- Backend는 proof를 relay하며 요청에서 임의 fare를 받지 않는다.
- 컨트랙트가 final state, signatures, appData domain과 fare를 직접 검증한다.
- `settleAndRelease`는 지급을 예약하고 dispute window 후 `claimSettlement`이 실제 USDC를 분배한다.
- 완료 표시는 CLAIM confirmed 또는 온체인 `settlementClaimed` 뒤에만 나온다.

## 이번 정리에서 수정한 어긋남

- DB보다 Redis가 먼저 바뀌어 종료 뒤 과금이 계속될 수 있던 순서를 DB-first로 변경했다.
- 종료와 1분 scheduler 경쟁을 PostgreSQL advisory lock으로 직렬화했다.
- 종료 시 먼저 DB 상태를 Ended로 고정한 뒤 마지막 완성된 1분을 반영한다.
- Go 업데이트 뒤 DB 감사 저장이 실패하면 Go의 누적 nonce/balance로 DB를 복구한다.
- Go 상태 API가 하드코딩된 0 대신 실제 누적 balance와 state hash를 반환한다.
- SETTLE/CLAIM 영수증, escrow/session, settlements 변경을 DB transaction 하나로 묶었다.
- `Released`를 지급 완료로 표시하던 판정을 수정했다.
- 프론트가 종료 응답을 잃었을 때 Active로 되돌아가 요금을 계속 표시하던 동작을 제거했다.
- 임의 `fareUsdc`, 구형 `/sign`, 메모리 채널 API, 별도 cron/watchtower를 제거했다.
- 서로 다른 구형 escrow 소스·ABI·배포 스크립트와 이를 쓰던 가짜 E2E를 제거했다.

## 남은 설계 차이와 운영 제한

1. 두 번째 Perun participant는 사용자의 MetaMask가 아니라 Go 프로세스가 만든 custodial participant다. 현재 proof는 native Perun signatures이지만 사용자가 직접 소유한 키의 서명은 아니다.
2. final proof는 persistence에서 복구할 수 있지만, 활성 채널의 custodial user key와 LocalBus peer는 재시작 후 완전히 복구되지 않는다. 세션 도중 Go 서비스가 재시작되면 최종 업데이트 대신 recovery/refund 경로로 갈 수 있다.
3. 환불 화면이 evaluate/approve/payout 운영 작업을 브라우저에서 호출한다. wallet ownership signature와 운영자 전용 인증을 분리해야 한다.
4. settlement scheduler의 중복 실행 방지는 단일 Backend replica를 전제로 한다. 여러 replica를 쓰려면 claim/settle에도 DB advisory lock을 적용해야 한다.
5. 실제 MetaMask 예치가 필요한 Railway E2E는 사용자 지갑 승인이 있어야 완결할 수 있다.

1번과 2번을 해결하려면 사용자 participant 키 관리/P2P 모델을 논문에서 명시하고, 선택한 모델에 맞춘 active-channel restore를 별도 단계로 구현해야 한다. 현재 구현의 신뢰 경계는 “escrow fare 변조 방지”까지 충족하지만 “사용자 키 비수탁”까지 충족하지는 않는다.
