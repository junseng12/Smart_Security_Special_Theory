// channel_test.go — go-perun 핵심 로직 단위 테스트 (네트워크 불필요)
package channel

import (
	"fmt"
	"math/big"
	"testing"

	"smartcity/go-perun-node/internal/pricing"
)

// ── 1. usdcToWei 변환 테스트 ────────────────────────────────────

func TestUsdcToWei(t *testing.T) {
	cases := []struct {
		input    string
		expected int64
	}{
		{"1.0", 1_000_000},
		{"2.5", 2_500_000},
		{"0.01", 10_000},
		{"0.000001", 1},
	}
	for _, c := range cases {
		got := usdcToWei(c.input)
		if got.Cmp(big.NewInt(c.expected)) != 0 {
			t.Errorf("usdcToWei(%q) = %s, want %d", c.input, got, c.expected)
		}
	}
}

// ── 2. pricing.Engine 요금 계산 테스트 ──────────────────────────

func TestPricingBicycle(t *testing.T) {
	eng := pricing.NewEngine()

	// 5분 자전거 → 0.05 USDC
	res, err := eng.CalculateFare(pricing.UsageDelta{
		ServiceType:     "bicycle",
		DurationMinutes: 5,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.FareUsdc != "0.050000" {
		t.Errorf("bicycle 5min: got %s, want 0.050000", res.FareUsdc)
	}
	t.Logf("✅ bicycle 5min → %s USDC (policy: %s)", res.FareUsdc, res.PolicyHash[:10]+"...")
}

func TestPricingEV(t *testing.T) {
	eng := pricing.NewEngine()

	// 10kWh EV 충전 → 2.5 USDC
	res, err := eng.CalculateFare(pricing.UsageDelta{
		ServiceType: "ev_charging",
		EnergyKwh:   10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.FareUsdc != "2.500000" {
		t.Errorf("ev 10kWh: got %s, want 2.500000", res.FareUsdc)
	}
	t.Logf("✅ ev_charging 10kWh → %s USDC", res.FareUsdc)
}

func TestPricingParking(t *testing.T) {
	eng := pricing.NewEngine()

	// 30분 주차 → 0.15 USDC
	res, err := eng.CalculateFare(pricing.UsageDelta{
		ServiceType:     "parking",
		DurationMinutes: 30,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.FareUsdc != "0.150000" {
		t.Errorf("parking 30min: got %s, want 0.150000", res.FareUsdc)
	}
	t.Logf("✅ parking 30min → %s USDC", res.FareUsdc)
}

func TestPricingCap(t *testing.T) {
	eng := pricing.NewEngine()

	// 1000분 자전거 → 캡(5.0 USDC) 적용
	res, err := eng.CalculateFare(pricing.UsageDelta{
		ServiceType:     "bicycle",
		DurationMinutes: 1000,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.FareUsdc != "5.000000" {
		t.Errorf("bicycle 1000min: got %s, want 5.000000 (cap)", res.FareUsdc)
	}
	t.Logf("✅ bicycle 1000min → %s USDC (capped)", res.FareUsdc)
}

func TestPricingMinCharge(t *testing.T) {
	eng := pricing.NewEngine()

	// 0분 자전거 → 최소 1분 적용 → 0.01 USDC
	res, err := eng.CalculateFare(pricing.UsageDelta{
		ServiceType:     "bicycle",
		DurationMinutes: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.FareUsdc != "0.010000" {
		t.Errorf("bicycle 0min: got %s, want 0.010000 (min_charge)", res.FareUsdc)
	}
	t.Logf("✅ bicycle 0min → %s USDC (min charge)", res.FareUsdc)
}

// ── 3. FinalFare (credit 처리) 테스트 ───────────────────────────

func TestFinalFare(t *testing.T) {
	cases := []struct {
		charged  string
		credit   string
		wantNet  string
	}{
		{"1.000000", "0.200000", "0.800000"}, // 크레딧 20% 환급
		{"0.500000", "0.000000", "0.500000"}, // 크레딧 없음
		{"1.000000", "1.500000", "0.000000"}, // 크레딧이 요금 초과 → 0
	}
	for _, c := range cases {
		net, cWei := pricing.FinalFare(c.charged, c.credit)
		if net != c.wantNet {
			t.Errorf("FinalFare(%s, %s) net = %s, want %s", c.charged, c.credit, net, c.wantNet)
		}
		t.Logf("✅ charged=%s credit=%s → net=%s creditWei=%s",
			c.charged, c.credit, net, cWei.String())
	}
}

// ── 4. WeiToUsdc 역변환 테스트 ───────────────────────────────────

func TestWeiToUsdc(t *testing.T) {
	cases := []struct {
		wei      int64
		expected string
	}{
		{1_000_000, "1.000000"},
		{500_000,   "0.500000"},
		{1,         "0.000001"},
		{0,         "0.000000"},
	}
	for _, c := range cases {
		got := pricing.WeiToUsdc(big.NewInt(c.wei))
		if got != c.expected {
			t.Errorf("WeiToUsdc(%d) = %s, want %s", c.wei, got, c.expected)
		}
	}
	t.Log("✅ WeiToUsdc 역변환 OK")
}

// ── 5. 채널 흐름 시뮬레이션 (on-chain 없이) ─────────────────────

func TestChannelFlowSimulation(t *testing.T) {
	eng := pricing.NewEngine()
	deposit := int64(2_000_000) // 2 USDC (wei)
	userBal  := big.NewInt(deposit)
	opBal    := big.NewInt(0)

	services := []struct {
		svc string
		dur float64
		kwh float64
	}{
		{"bicycle", 5, 0},
		{"parking", 10, 0},
		{"ev_charging", 0, 2},
	}

	t.Log("=== 채널 흐름 시뮬레이션 ===")
	t.Logf("초기 잔액: user=%.6f USDC op=%.6f USDC",
		float64(deposit)/1e6, 0.0)

	for i, svc := range services {
		res, err := eng.CalculateFare(pricing.UsageDelta{
			ServiceType:     svc.svc,
			DurationMinutes: svc.dur,
			EnergyKwh:       svc.kwh,
		})
		if err != nil {
			t.Fatal(err)
		}
		// 잔액 이동 시뮬레이션
		userBal.Sub(userBal, res.FareWei)
		opBal.Add(opBal, res.FareWei)

		t.Logf("[%d] %-12s → fare=%s | user=%.6f | op=%.6f",
			i+1, svc.svc, res.FareUsdc,
			float64(userBal.Int64())/1e6,
			float64(opBal.Int64())/1e6,
		)
		if userBal.Sign() < 0 {
			t.Error("❌ 잔액 마이너스 발생!")
		}
	}

	// 최종 정산
	netUsdc, creditWei := pricing.FinalFare(pricing.WeiToUsdc(opBal), "0.0")
	_ = creditWei
	t.Logf("\n=== 최종 정산 ===")
	t.Logf("총 요금: %s USDC", netUsdc)
	t.Logf("환급액: %.6f USDC", float64(userBal.Int64())/1e6)

	fmt.Printf("\n✅ 채널 흐름 시뮬레이션 완료\n")
}
