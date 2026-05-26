package pricing

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
)

type Policy struct {
	ServiceType  string  `json:"service_type"`
	Version      string  `json:"version"`
	RatePerMin   float64 `json:"rate_per_min,omitempty"`
	RatePerKwh   float64 `json:"rate_per_kwh,omitempty"`
	MinChargeMin float64 `json:"min_charge_min"`
	CapUsdc      float64 `json:"cap_usdc"`
}

func (p *Policy) PolicyHash() string {
	b, _ := json.Marshal(p)
	h := sha256.Sum256(b)
	return "0x" + hex.EncodeToString(h[:])
}

var DefaultPolicies = map[string]*Policy{
	"bicycle":     {ServiceType: "bicycle",     Version: "v1.0.0", RatePerMin: 0.01,  MinChargeMin: 1, CapUsdc: 5.0},
	"ev_charging": {ServiceType: "ev_charging", Version: "v1.0.0", RatePerKwh: 0.25,  MinChargeMin: 0, CapUsdc: 20.0},
	"parking":     {ServiceType: "parking",     Version: "v1.0.0", RatePerMin: 0.005, MinChargeMin: 1, CapUsdc: 3.0},
}

type Engine struct{ policies map[string]*Policy }

func NewEngine() *Engine { return &Engine{policies: DefaultPolicies} }

type UsageDelta struct {
	ServiceType     string
	DurationMinutes float64
	EnergyKwh       float64
}

type FareResult struct {
	FareUsdc    string
	FareWei     *big.Int
	PolicyHash  string
}

func (e *Engine) CalculateFare(u UsageDelta) (*FareResult, error) {
	p, ok := e.policies[u.ServiceType]
	if !ok {
		return nil, fmt.Errorf("no policy for: %s", u.ServiceType)
	}
	var raw float64
	switch u.ServiceType {
	case "bicycle", "parking":
		dur := u.DurationMinutes
		if dur < p.MinChargeMin { dur = p.MinChargeMin }
		raw = dur * p.RatePerMin
	case "ev_charging":
		raw = u.EnergyKwh * p.RatePerKwh
	}
	if p.CapUsdc > 0 && raw > p.CapUsdc { raw = p.CapUsdc }
	return &FareResult{
		FareUsdc:   fmt.Sprintf("%.6f", raw),
		FareWei:    usdcToWei(raw),
		PolicyHash: p.PolicyHash(),
	}, nil
}

// FinalFare: 총 charged - credit = 최종 순 요금
// creditWei는 operator→user 환급액 (양수)
func FinalFare(totalChargedUsdc, creditUsdc string) (netUsdc string, creditWei *big.Int) {
	var charged, credit float64
	fmt.Sscanf(totalChargedUsdc, "%f", &charged)
	fmt.Sscanf(creditUsdc, "%f", &credit)
	if credit < 0 { credit = 0 }
	if credit > charged { credit = charged }
	return fmt.Sprintf("%.6f", charged-credit), usdcToWei(credit)
}

func usdcToWei(usdc float64) *big.Int {
	bf := new(big.Float).SetPrec(128).SetFloat64(usdc)
	bf.Mul(bf, new(big.Float).SetPrec(128).SetInt64(1_000_000))
	r, _ := bf.Int(nil)
	return r
}

func WeiToUsdc(wei *big.Int) string {
	if wei == nil { return "0.000000" }
	f := new(big.Float).SetPrec(128).SetInt(wei)
	f.Quo(f, new(big.Float).SetPrec(128).SetInt64(1_000_000))
	v, _ := f.Float64()
	return fmt.Sprintf("%.6f", v)
}
