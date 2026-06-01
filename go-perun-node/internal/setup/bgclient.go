// Package setup — backgroundClient wraps ethclient to use context.Background()
// for SubscribeNewHead, preventing gRPC deadline cancellation from killing
// the block subscription used by perun-eth-backend's ResistantEventSub.
package setup

import (
	"context"

	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/ethclient"
)

// backgroundChainReader wraps ethclient.Client and overrides SubscribeNewHead
// to always use context.Background(), detaching it from any gRPC deadline.
type backgroundChainReader struct {
	*ethclient.Client
}

// SubscribeNewHead — context를 Background로 교체하여 gRPC deadline 영향 차단
func (b *backgroundChainReader) SubscribeNewHead(_ context.Context, ch chan<- *types.Header) (ethereum.Subscription, error) {
	return b.Client.SubscribeNewHead(context.Background(), ch)
}
