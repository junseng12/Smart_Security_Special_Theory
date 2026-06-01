// custodial.go — LocalBus 기반 custodial 사용자 노드
// ★ libp2p P2P 완전 제거 — shared LocalBus로 operator와 인메모리 통신
package setup

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	ethchannel "github.com/perun-network/perun-eth-backend/channel"
	ethwallet  "github.com/perun-network/perun-eth-backend/wallet"
	swallet    "github.com/perun-network/perun-eth-backend/wallet/simple"
	"perun.network/go-perun/client"
	"perun.network/go-perun/wallet"
	"perun.network/go-perun/watcher/local"
	"perun.network/go-perun/wire"
)

// UserNode — custodial 사용자 노드 (세션별로 생성, shared LocalBus 사용)
type UserNode struct {
	Client      *client.Client
	EthAddress  map[wallet.BackendID]wallet.Address
	WireAddress map[wallet.BackendID]wire.Address
	Address     common.Address
}

// NewUserNode — shared LocalBus로 사용자 go-perun 클라이언트 생성
// operator의 PerunNode.Bus를 공유하므로 P2P dial 불필요
func NewUserNode(cfg *Config, bus *wire.LocalBus) (*UserNode, error) {
	// 1. 랜덤 사용자 키쌍 생성
	privKey, err := crypto.GenerateKey()
	if err != nil {
		return nil, fmt.Errorf("generating user key: %w", err)
	}
	userAddr := crypto.PubkeyToAddress(privKey.PublicKey)

	// 2. simple wallet
	w   := swallet.NewWallet(privKey)
	acc := accounts.Account{Address: userAddr}
	eaddr := ethwallet.AsWalletAddr(userAddr)

	// 3. ContractBackend
	cb, err := newContractBackend(cfg.RPCURL, cfg.ChainID, w)
	if err != nil {
		return nil, fmt.Errorf("user contract backend: %w", err)
	}

	// 4. Funder
	funder    := ethchannel.NewFunder(cb)
	usdcAsset := ethchannel.NewAsset(new(big.Int).SetUint64(cfg.ChainID), cfg.AssetHolderAddr)
	funder.RegisterAsset(*usdcAsset, ethchannel.NewERC20Depositor(cfg.USDCTokenAddr, 300_000), acc)

	// 5. Adjudicator
	adj := ethchannel.NewAdjudicator(cb, cfg.AdjudicatorAddr, cfg.ReceiverAddr, acc, 1_000_000)

	// 6. Watcher
	watcher, err := local.NewWatcher(adj)
	if err != nil {
		return nil, fmt.Errorf("user watcher: %w", err)
	}

	// 7. ★ wire 주소 — LocalBus용 가상 주소 (P2P 불필요)
	userWireKey, err := crypto.GenerateKey()
	if err != nil {
		return nil, fmt.Errorf("generating user wire key: %w", err)
	}
	userWireAddr := ethwallet.AsWalletAddr(crypto.PubkeyToAddress(userWireKey.PublicKey))
	wireAddrs := map[wallet.BackendID]wire.Address{ethwallet.BackendID: userWireAddr}
	eAddrs    := map[wallet.BackendID]wallet.Address{ethwallet.BackendID: eaddr}

	// 8. go-perun Client — shared bus 사용
	wallets := map[wallet.BackendID]wallet.Wallet{ethwallet.BackendID: w}
	signer  := types.NewLondonSigner(new(big.Int).SetUint64(cfg.ChainID))
	_ = signer

	perunClient, err := client.New(wireAddrs, bus, funder, adj, wallets, watcher)
	if err != nil {
		return nil, fmt.Errorf("creating user perun client: %w", err)
	}

	return &UserNode{
		Client:      perunClient,
		EthAddress:  eAddrs,
		WireAddress: wireAddrs,
		Address:     userAddr,
	}, nil
}
