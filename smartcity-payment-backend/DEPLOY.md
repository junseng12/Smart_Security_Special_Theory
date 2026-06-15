# Deploy Log
2026-06-15 15:30:58 UTC

## 이번 배포 수정 사항
1. escrowPayoutService.js — V3.2 인터페이스 완전 재작성
2. escrowPayoutService.js — operatorDeposit 함수 추가/export
3. ScanPay.jsx — 컨트랙트 주소 0x454D→0xa264 수정
4. ScanPay.jsx — startSession 순서: start→escrowId→MetaMask→deposit
5. ScanPay.jsx — endSession fareUsdc 전달 추가
6. refunds.js — sessions.session_id→sessions.id SQL 수정
7. sessions.js — isRealTx 조건 완화
8. sessions.js — /end deferred 202 반환으로 타임아웃 방지

Contract: 0xa2642876a2Aa9F19D22a6e69379bbcA10556977f
