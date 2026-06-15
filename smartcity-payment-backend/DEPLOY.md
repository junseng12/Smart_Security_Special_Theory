# Deploy — 2026-06-15T16:46:23Z
- operatorDeposit: 온체인 None + DB UserDeposited 시 실행 허용
- /end race timeout: 25s → 8s (Railway 502 방지)
- settled 판정: Released + Refunded 모두 포함
- claimSettlement stub 추가
- RefundCenter: evaluate 결과 확인 후 payout 조건부 실행
