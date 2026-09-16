# Handover

현재 구현과 남은 제한은 [DESIGN_AUDIT.md](DESIGN_AUDIT.md)에 정리돼 있다.

운영 변수와 외부 E2E 절차는 [smartcity-payment-backend/RUNBOOK.md](smartcity-payment-backend/RUNBOOK.md)를 사용한다.

컨트랙트의 단일 소스는 [smartcontract/SmartCityEscrow.sol](smartcontract/SmartCityEscrow.sol)이다. Backend와 Go 저장소에서 컨트랙트를 배포하는 경로는 제거됐다.

로컬 검증 명령:

```bash
cd go-perun-node && go test ./...
cd ../smartcity-payment-backend && npm ci && npm test
cd ../smartcontract && npm test
cd ../smartcity-payment-frontend && npm ci && npm run build
```
