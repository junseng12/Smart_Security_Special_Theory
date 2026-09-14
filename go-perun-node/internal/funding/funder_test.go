package funding

import (
	"context"
	"errors"
	"math/big"
	"testing"

	"perun.network/go-perun/channel"
)

type recordingFunder struct {
	calls int
	req   channel.FundingReq
	err   error
}

func (f *recordingFunder) Fund(_ context.Context, req channel.FundingReq) error {
	f.calls++
	f.req = req
	return f.err
}

func TestZeroSkippingFunderSkipsAllZeroAgreement(t *testing.T) {
	delegate := new(recordingFunder)
	funder := NewZeroSkippingFunder(delegate)
	req := channel.FundingReq{Agreement: channel.Balances{
		{big.NewInt(0), big.NewInt(0)},
		{big.NewInt(0), big.NewInt(0)},
	}}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := funder.Fund(ctx, req); err != nil {
		t.Fatalf("zero agreement returned error: %v", err)
	}
	if delegate.calls != 0 {
		t.Fatalf("delegate called %d times, want 0", delegate.calls)
	}
}

func TestZeroSkippingFunderDelegatesNonZeroAgreement(t *testing.T) {
	delegateErr := errors.New("delegate failure")
	delegate := &recordingFunder{err: delegateErr}
	funder := NewZeroSkippingFunder(delegate)
	req := channel.FundingReq{Agreement: channel.Balances{
		{big.NewInt(0), big.NewInt(1)},
	}}

	err := funder.Fund(context.Background(), req)
	if !errors.Is(err, delegateErr) {
		t.Fatalf("got error %v, want %v", err, delegateErr)
	}
	if delegate.calls != 1 {
		t.Fatalf("delegate called %d times, want 1", delegate.calls)
	}
	if delegate.req.Agreement[0][1].Cmp(req.Agreement[0][1]) != 0 {
		t.Fatal("funding request was not delegated unchanged")
	}
}

func TestZeroSkippingFunderDelegatesMalformedAgreement(t *testing.T) {
	tests := []struct {
		name      string
		agreement channel.Balances
	}{
		{name: "missing assets", agreement: nil},
		{name: "missing participants", agreement: channel.Balances{{}}},
		{name: "nil balance", agreement: channel.Balances{{nil, big.NewInt(0)}}},
		{name: "negative balance", agreement: channel.Balances{{big.NewInt(-1), big.NewInt(0)}}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			delegate := new(recordingFunder)
			funder := NewZeroSkippingFunder(delegate)

			if err := funder.Fund(context.Background(), channel.FundingReq{Agreement: tt.agreement}); err != nil {
				t.Fatalf("delegated funding returned error: %v", err)
			}
			if delegate.calls != 1 {
				t.Fatalf("delegate called %d times, want 1", delegate.calls)
			}
		})
	}
}
