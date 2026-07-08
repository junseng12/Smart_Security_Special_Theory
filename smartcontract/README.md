# SmartCityEscrow V3.2

카드사 방식의 중간 정산 컨트랙트.  
`settleAndRelease()` 호출 시 자금을 즉시 전송하지 않고 **24시간 분쟁 기간** 동안 컨트랙트에 보관한다.

---

## 상태 머신

```
None
  └→ UserDeposited       userDeposit()
       └→ FullyFunded    operatorDeposit()
            ├→ Released  settleAndRelease()  ← 예약만. 자금은 컨트랙트 보관
            │    └→ Released (claimed)       claimSettlement()  ← 24h 후 실제 전송
            ├→ RefundIssue                   registerRefundIssue()  ← 24h 내 분쟁
            │    └→ Refunded                 refundToBuyer(refundFare)
            └→ Refunded                      forceRefund()  ← holdDeadline+1h 후 누구나
                                             emergencyCancel()  ← admin
```

---

## 주요 함수

### `userDeposit(escrowId, operator, amount, holdDeadline)`
사용자가 서비스 시작 전 보증금 예치.  
사전에 `USDC.approve(escrowContract, amount)` 필요.

### `operatorDeposit(escrowId, amount)`
운영자 보증금 예치. `OPERATOR_ROLE` 전용.

### `settleAndRelease(escrowId, fareAmount)`
정산 예약. 자금은 컨트랙트에 보관하고 24시간 분쟁 기간 시작.  
`FullyFunded` 상태 + `holdDeadline` 이후에만 호출 가능.

### `claimSettlement(escrowId)`
24시간 분쟁 기간 종료 후 예약된 정산 실행.  
- `fare` → operator
- `userRefund` → user  
- `operatorRefund` → operator

### `registerRefundIssue(escrowId, issueType, description, penalizeOperator)`
분쟁 이슈 등록. `FullyFunded` 또는 `Released`(24h 이내) 상태에서 가능.  
`OPERATOR_ROLE` 전용.

**issueType enum:**
| 값 | 이름 | 설명 |
|---|---|---|
| 0 | UnlockFailure | 자전거 unlock 실패 |
| 1 | DeviceFault | 기기 고장 |
| 2 | WrongCharge | 잘못된 요금 청구 |
| 3 | SensorFailure | 센서 오류 |
| 4 | ServiceOutage | 서비스 장애 |
| 5 | Other | 기타 |

### `refundToBuyer(escrowId, refundFare)`
환불 실행. **`refundFare`는 백엔드가 issueType과 실이용 데이터 기반으로 결정.**

| 케이스 | refundFare | 결과 |
|---|---|---|
| unlock 실패 / 완전 장애 | `0` | user 전액 환불 |
| 부분 이용 후 기기 고장 | `실이용 fare` | fare→operator, 나머지→user |
| 센서 오류 과다 청구 | `정상 fare` | 차액→user 환불 |

운영자 보증금(`operatorDeposit`)은 항상 operator에게 반환 (사용자에게 패널티로 지급하지 않음).

---

## 환불 정책 요약

| 상황 | refundFare | penalizeOperator |
|---|---|---|
| unlock 실패 | 0 | true (기록용) |
| 기기 고장 (부분 이용) | 실이용 fare | true |
| 잠금장치 고장 → 반납 불가 | 실이용 fare | true |
| 서버/API 장애 | 0 ~ 실이용 fare | true |
| 센서 오류 과다 청구 | 정상 fare | true |

| 환불 거부 케이스 |
|---|
| 24시간 분쟁 기간 경과 |
| 정상 이용 확인 |
| 사용자 변심 / 과실 |
| 이미 claimSettlement 완료 |
| 이미 Refunded 상태 |

---

## 온체인 증거 이벤트

| 이벤트 | 의미 |
|---|---|
| `UserDeposited` | 사용자 보증금 예치 |
| `OperatorDeposited` | 운영자 보증금 예치 |
| `SettlementReserved` | 24h 분쟁 기간 시작 |
| `RefundIssueRegistered` | 분쟁 이슈 등록 |
| `RefundedToBuyer` | 환불 실행 |
| `SettlementClaimed` | 정상 정산 완료 |
| `EmergencyCancelled` | 긴급 취소 (admin) |

---

## 백엔드 연동 포인트

### 변경된 ABI (V3.1 → V3.2)
```
refundToBuyer(bytes32)  →  refundToBuyer(bytes32, uint256)
```

백엔드 `escrowPayoutService.js` 에서 `refundToBuyer` 호출 시 `refundFare` 추가 필요:

```js
// escrowPayoutService.js
async function executeRefundToBuyer(escrowId, refundFare) {
  const tx = await escrowContract.refundToBuyer(
    escrowId,
    ethers.parseUnits(refundFare.toFixed(6), 6)  // USDC 6 decimals
  );
  return await tx.wait();
}
```

### issueType별 refundFare 결정 로직 (백엔드 책임)
```js
// channelOrchestrator.js 또는 refundDecisionEngine.js
function calcRefundFare(issueType, confirmedUsageFare) {
  switch (issueType) {
    case 'UnlockFailure':   return 0;             // 전액 환불
    case 'ServiceOutage':   return 0;             // 전액 환불
    case 'DeviceFault':     return confirmedUsageFare;  // 실이용분
    case 'WrongCharge':     return confirmedUsageFare;  // 정상 요금만
    case 'SensorFailure':   return confirmedUsageFare;  // 정상 요금만
    default:                return confirmedUsageFare;
  }
}
```

### 정산 흐름 (settleAndRelease → claimSettlement)
```
[현재 백엔드 흐름]
orchestrator.endSessionAndSettle()
  → escrowSvc.settleAndRelease()   ← 그대로 유지
  → (NEW) 24h 후 claimSettlement() 호출 필요

[추가 필요]
- DB에 claimableAfter 저장
- 24h 후 자동으로 claimSettlement() 호출하는 워커/크론
```

---

## 배포

```bash
cd smartcontract
npm install
cp .env.example .env   # DEPLOYER_PRIVATE_KEY, OPERATOR_ADDRESS, USDC_ADDRESS 설정
npm run compile
npm run deploy:sepolia
```

### Base Sepolia 주소
| 항목 | 주소 |
|---|---|
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Operator | `0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7` |
