// Package pricing은 사용량 → USDC 요금 계산을 담당합니다.
//
// 핵심 설계:
//   - 정책(Policy)은 버전 해시로 고정됩니다.
//   - 요금 계산 전 PolicyHash를 검증하면 "서명 전 분쟁 방지" 가능.
//   - finalUpdateAndAdjust()에서 누적 credit을 차감해 최종 요금 확정.
package pricing

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
)

// ────────────────────────────────────────────────────────────────────
// Policy — 서비스별 요금 정책
// ────────────────────────────────────────────────────────────────────

// Policy는 단일 서비스의 요금 규칙입니다.
type Policy struct {
	ServiceType   string  `json:"service_type"`
	Version       string  `json:"version"`
	RatePerMin    float64 `json:"rate_per_min,omitempty"`    // USDC/분 (자전거, 주차)
	RatePerKwh    float64 `json:"rate_per_kwh,omitempty"`    // USDC/kWh (EV 충전)
	MinChargeMin  float64 `json:"min_charge_min"`            // 최소 과금 분 (기본 1분)
	CapUsdc       float64 `json:"cap_usdc"`                  // 최대 요금 상한선 (0=무제한)
}

// PolicyHash는 정책 내용의 SHA-256 해시입니다.
// 사용자가 서명 전에 이 해시를 검증해 "내가 동의한 요금표"임을 확인할 수 있습니다.
func (p *Policy) PolicyHash() string {
	b, _ := json.Marshal(p)
	h := sha256.Sum256(b)
	return "0x" + hex.EncodeToString(h[:])
}

// ────────────────────────────────────────────────────────────────────
// 기본 정책 (DB에서 로드하기 전 초기값)
// ────────────────────────────────────────────────────────────────────

var DefaultPolicies = map[string]*Policy{
	"bicycle": {
		ServiceType:  "bicycle",
		Version:      "v1.0.0",
		RatePerMin:   0.01,  // 분당 0.01 USDC
		MinChargeMin: 1.0,
		CapUsdc:      5.0,   // 최대 5 USDC
	},
	"ev_charging": {
		ServiceType:  "ev_charging",
		Version:      "v1.0.0",
		RatePerKwh:   0.25,  // kWh당 0.25 USDC
		MinChargeMin: 0.0,
		CapUsdc:      20.0,
	},
	"parking": {
		ServiceType:  "parking",
		Version:      "v1.0.0",
		RatePerMin:   0.005, // 분당 0.005 USDC
		MinChargeMin: 1.0,
		CapUsdc:      3.0,
	},
}

// ────────────────────────────────────────────────────────────────────
// Engine — 요금 계산 엔진
// ────────────────────────────────────────────────────────────────────

// Engine은 정책을 보관하고 요금을 계산합니다.
type Engine struct {
	policies map[string]*Policy
}

// NewEngine은 기본 정책으로 엔진을 초기화합니다.
func NewEngine() *Engine {
	return &Engine{policies: DefaultPolicies}
}

// LoadPolicy는 정책을 런타임에 교체합니다 (DB 로드용).
func (e *Engine) LoadPolicy(p *Policy) {
	e.policies[p.ServiceType] = p
}

// ────────────────────────────────────────────────────────────────────
// CalculateFare — 사용량 → 요금 계산
//
// go-perun 연동 포인트:
//   이 함수의 반환값 FareResult.FareWei가
//   ch.Update()의 state.Allocation.TransferBalance() 인수로 사용됩니다.
//
//   즉, Perun 채널 상태에서:
//     balances[user]    -= FareWei
//     balances[operator] += FareWei
//
// 이 계산은 operator(백엔드)가 먼저 수행하고,
// 결과(stateHash + policyHash)를 프론트에 전달해 사용자가 검증 후 서명합니다.
// ────────────────────────────────────────────────────────────────────

type UsageDelta struct {
	DurationMinutes float64
	EnergyKwh       float64
	ServiceType     string
}

type FareResult struct {
	ServiceType  string
	FareUsdc     string   // human-readable (소수점 6자리)
	FareWei      *big.Int // 1 USDC = 10^6 (6 decimals)
	PolicyHash   string
	PolicyVersion string
	DurationMin  float64
	RateApplied  float64
	CapApplied   bool
}

func (e *Engine) CalculateFare(usage UsageDelta) (*FareResult, error) {
	policy, ok := e.policies[usage.ServiceType]
	if !ok {
		return nil, fmt.Errorf("no policy for service type: %s", usage.ServiceType)
	}

	var rawFare float64

	switch usage.ServiceType {
	case "bicycle", "parking":
		// 분 기반 과금
		dur := usage.DurationMinutes
		if dur < policy.MinChargeMin {
			dur = policy.MinChargeMin // 최소 1분 과금
		}
		rawFare = dur * policy.RatePerMin

	case "ev_charging":
		// kWh 기반 과금
		rawFare = usage.EnergyKwh * policy.RatePerKwh
	}

	// 상한선 적용
	capApplied := false
	if policy.CapUsdc > 0 && rawFare > policy.CapUsdc {
		rawFare = policy.CapUsdc
		capApplied = true
	}

	// USDC → wei (6 decimals)
	fareWei := usdcToWei(rawFare)

	return &FareResult{
		ServiceType:   usage.ServiceType,
		FareUsdc:      fmt.Sprintf("%.6f", rawFare),
		FareWei:       fareWei,
		PolicyHash:    policy.PolicyHash(),
		PolicyVersion: policy.Version,
		DurationMin:   usage.DurationMinutes,
		RateApplied:   policy.RatePerMin,
		CapApplied:    capApplied,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// FinalFare — finalUpdateAndAdjust 전용
//
// 최종 요금 = 누적 요금 - 누적 credit
//
// go-perun 연동 포인트:
//   이 값이 ch.Update(ctx, func(state) { state.IsFinal = true; ... })에서
//   최종 balances를 결정합니다.
//   IsFinal=true → 이후 ch.Settle() 호출 가능.
// ────────────────────────────────────────────────────────────────────
func FinalFare(totalChargedUsdc, totalCreditUsdc string) (netUsdc string, netWei *big.Int) {
	var charged, credit float64
	fmt.Sscanf(totalChargedUsdc, "%f", &charged)
	fmt.Sscanf(totalCreditUsdc, "%f", &credit)

	net := charged - credit
	if net < 0 {
		net = 0
	}

	return fmt.Sprintf("%.6f", net), usdcToWei(net)
}

// ────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────

// usdcToWei: USDC float → wei (*big.Int), 6 decimals
func usdcToWei(usdc float64) *big.Int {
	// 소수점 손실 방지: 문자열로 변환 후 파싱
	s := fmt.Sprintf("%.6f", usdc)
	// "1.234567" → 1234567 (× 10^6)
	var intPart, fracPart int64
	fmt.Sscanf(s, "%d.%d", &intPart, &fracPart)

	// 정수부 × 10^6 + 소수부 (항상 6자리로 패딩)
	fracStr := fmt.Sprintf("%.6f", usdc)
	// big.Float 사용으로 정밀도 보장
	bf := new(big.Float).SetPrec(128)
	bf.SetString(fracStr)
	multiplier := new(big.Float).SetPrec(128).SetInt64(1_000_000)
	bf.Mul(bf, multiplier)
	result, _ := bf.Int(nil)
	return result
}

// WeiToUsdc: wei *big.Int → USDC string
func WeiToUsdc(wei *big.Int) string {
	if wei == nil {
		return "0.000000"
	}
	f := new(big.Float).SetPrec(128).SetInt(wei)
	div := new(big.Float).SetPrec(128).SetInt64(1_000_000)
	f.Quo(f, div)
	res, _ := f.Float64()
	return fmt.Sprintf("%.6f", res)
}
