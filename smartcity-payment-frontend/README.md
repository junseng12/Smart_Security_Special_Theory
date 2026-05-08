# SmartCity Payment — Frontend

Base44 앱 빌더 기반의 스마트시티 마이크로페이먼트 프론트엔드입니다.  
Base Chain + Perun State Channel 백엔드와 연동됩니다.

## 기술 스택

- **Framework:** React + Vite
- **Styling:** Tailwind CSS + shadcn/ui
- **Animation:** Framer Motion
- **State:** TanStack Query
- **Auth/DB:** Base44 SDK
- **Backend:** [smartcity-payment-backend](../backend) on Railway

## 화면 구성

| 경로 | 화면 | 설명 |
|------|------|------|
| `/` | Dashboard | 잔액 카드, 빠른 액션, 최근 거래 |
| `/scan` | QR 결제 | 서비스 선택 → Perun 세션 시작 → 실시간 타이머 → 정산 |
| `/deposit` | 입금 | USDC 입금 시뮬레이션 |
| `/send` | 송금 | 다른 주소로 USDC 전송 |
| `/history` | 사용내역 | 전체 트랜잭션 히스토리 |
| `/refund` | 환불 센터 | 환불 신청 + 케이스 조회 |
| `/profile` | 계정정보 | 지갑 주소, 통계, 로그아웃 |

## 주요 기능

### 회원가입 / 로그인
- Base44 Auth 기반 (Google 로그인 등)
- 최초 로그인 시 Base Chain 지갑 주소 자동 할당

### QR 결제 (Railway 백엔드 연동)
- 서비스 유형 선택 (주차 / 대중교통 / 자전거 / 전기차 충전)
- `POST /api/v1/sessions/start` → Perun 채널 오픈
- 실시간 타이머로 경과 시간 표시
- `POST /api/v1/sessions/:id/charge` → 요금 청구
- `POST /api/v1/sessions/:id/end` → 정산 + Base44 Transaction 기록

### 환불 센터
- 최근 결제 목록에서 세션 선택
- `POST /api/v1/refunds` → 환불 케이스 생성
- `GET /api/v1/refunds/:caseId` → 케이스 상태 조회
- 에스크로 기반 판정 프로세스 시각화

## 백엔드 연결

```
BACKEND = "https://smartcity-payment-backend-production.up.railway.app"
```

## Base44 앱 빌더 적용 방법

1. `https://app.base44.com` → BasePay 앱 열기
2. 수정 파일:
   - `src/App.jsx`
   - `src/pages/ScanPay.jsx`
   - `src/components/wallet/BottomNav.jsx`
3. 신규 파일:
   - `src/pages/RefundCenter.jsx`
4. 나머지 파일은 기존 유지
