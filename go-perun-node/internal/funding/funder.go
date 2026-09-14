// Package funding contains adapters for go-perun channel funding.
package funding

import (
	"context"

	"perun.network/go-perun/channel"
)

// ZeroSkippingFunder bypasses the blockchain funder when every balance in the
// funding agreement is zero. Non-zero and malformed agreements are delegated
// unchanged so that the underlying funder retains its validation and behavior.
type ZeroSkippingFunder struct {
	delegate channel.Funder
}

var _ channel.Funder = (*ZeroSkippingFunder)(nil)

// NewZeroSkippingFunder wraps delegate with the zero-funding fast path.
func NewZeroSkippingFunder(delegate channel.Funder) *ZeroSkippingFunder {
	if delegate == nil {
		panic("funding delegate must not be nil")
	}
	return &ZeroSkippingFunder{delegate: delegate}
}

// Fund returns immediately for a valid, entirely zero funding agreement.
// Otherwise it preserves the original funder's behavior.
func (f *ZeroSkippingFunder) Fund(ctx context.Context, req channel.FundingReq) error {
	if isZeroAgreement(req.Agreement) {
		return nil
	}
	return f.delegate.Fund(ctx, req)
}

func isZeroAgreement(agreement channel.Balances) bool {
	if len(agreement) == 0 {
		return false
	}

	for _, assetBalances := range agreement {
		if len(assetBalances) == 0 {
			return false
		}
		for _, balance := range assetBalances {
			if balance == nil || balance.Sign() != 0 {
				return false
			}
		}
	}
	return true
}
