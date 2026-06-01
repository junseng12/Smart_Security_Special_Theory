// custodial.go — 사용자 키쌍을 서버에서 생성/관리하는 custodial 헬퍼
// setup 패키지에 추가되는 파일

package setup

import (
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"math/rand"
	"time"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	ethchannel "github.com/perun-network/perun-eth-backend/channel"
	ethwallet "github.com/perun-network/perun-eth-backend/wallet"
	swallet "github.com/perun-network/perun-eth-backend/wallet/simple"
	"perun.network/go-perun/client"
	"perun.network/go-perun/wallet"
	"perun.network/go-perun/watcher/local"
	"perun.network/go-perun/wire"
	"perun.network/go-perun/wire/net"
	p2p "perun.network/go-perun/wire/net/libp2p"
	perunio "perun.network/go-perun/wire/perunio/serializer"
)

// UserNode — custodial 사용자 노드 (세션별로 생성)
type UserNode struct {
	Client      *client.Client
	EthAddress  map[wallet.BackendID]wallet.Address
	WireAddress map[wallet.BackendID]wire.Address
	PrivKey     *ecdsa.PrivateKey
	Address     common.Address
}

// NewUserNode — 새 사용자 키쌍으로 go-perun 클라이언트 생성
// 운영자 서버에서 custodial로 사용자 역할 수행
func NewUserNode(cfg *Config) (*UserNode, error) {
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

	// 3. ContractBackend (read-only 용도, funder도 등록)
	cb, err := newContractBackend(cfg.RPCURL, cfg.ChainID, w)
	if err != nil {
		return nil, fmt.Errorf("user contract backend: %w", err)
	}

	// 4. Funder (사용자도 deposit 서명 필요)
	funder   := ethchannel.NewFunder(cb)
	usdcAsset := ethchannel.NewAsset(new(big.Int).SetUint64(cfg.ChainID), cfg.AssetHolderAddr)
	funder.RegisterAsset(*usdcAsset, ethchannel.NewERC20Depositor(cfg.USDCTokenAddr, 300_000), acc)

	// 5. Adjudicator
	adj := ethchannel.NewAdjudicator(cb, cfg.AdjudicatorAddr, cfg.ReceiverAddr, acc, 1_000_000)

	// 6. Watcher
	watcher, err := local.NewWatcher(adj)
	if err != nil {
		return nil, fmt.Errorf("user watcher: %w", err)
	}

	// 7. P2P Wire (별도 포트, 랜덤)
	rng     := rand.New(rand.NewSource(time.Now().UnixNano()))
	wireAcc := p2p.NewRandomAccount(rng)
	listener := p2p.NewP2PListener(wireAcc)
	dialer   := p2p.NewP2PDialer(wireAcc)
	wireID   := map[wallet.BackendID]wire.Account{ethwallet.BackendID: wireAcc}
	bus      := net.NewBus(wireID, dialer, perunio.Serializer())
	go bus.Listen(listener)

	wireAddrs := map[wallet.BackendID]wire.Address{ethwallet.BackendID: wireAcc.Address()}
	eAddrs    := map[wallet.BackendID]wallet.Address{ethwallet.BackendID: eaddr}

	// 8. go-perun Client
	wallets := map[wallet.BackendID]wallet.Wallet{ethwallet.BackendID: w}
	signer  := types.NewLondonSigner(new(big.Int).SetUint64(cfg.ChainID))
	_ = signer // swallet이 내부에서 처리

	perunClient, err := client.New(wireAddrs, bus, funder, adj, wallets, watcher)
	if err != nil {
		return nil, fmt.Errorf("creating user perun client: %w", err)
	}

	return &UserNode{
		Client:      perunClient,
		EthAddress:  eAddrs,
		WireAddress: wireAddrs,
		PrivKey:     privKey,
		Address:     userAddr,
	}, nil
}

// PrivKeyHex — DB 저장용 hex 문자열 (0x 포함)
func (u *UserNode) PrivKeyHex() string {
	return fmt.Sprintf("0x%x", crypto.FromECDSA(u.PrivKey))
}
