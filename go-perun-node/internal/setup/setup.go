// Package setup — perun-eth-backend v0.6.0 + go-perun v0.15.0 기준 초기화
// ★ LocalBus 전환: libp2p P2P 제거, 동일 프로세스 내 인메모리 버스 사용
package setup

import (
	"context"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/pkg/errors"
	"github.com/sirupsen/logrus"

	ethchannel "github.com/perun-network/perun-eth-backend/channel"
	ethwallet  "github.com/perun-network/perun-eth-backend/wallet"
	ethwire    "github.com/perun-network/perun-eth-backend/wire"
	swallet    "github.com/perun-network/perun-eth-backend/wallet/simple"

	"perun.network/go-perun/channel"
	"perun.network/go-perun/client"
	"perun.network/go-perun/wallet"
	"perun.network/go-perun/watcher/local"
	"perun.network/go-perun/wire"
)

// Config — 환경변수에서 로드
type Config struct {
	RPCURL          string
	ChainID         uint64
	OperatorPrivKey string
	AdjudicatorAddr common.Address
	AssetHolderAddr common.Address
	USDCTokenAddr   common.Address
	ReceiverAddr    common.Address
	TxFinalityDepth uint64
}

// PerunNode — 초기화 완료된 go-perun 노드
type PerunNode struct {
	Client          *client.Client
	Bus             *wire.LocalBus        // ★ shared local bus (custodial user도 사용)
	OperatorAddr    common.Address
	OperatorAccount accounts.Account
	WireAddress     map[wallet.BackendID]wire.Address
	EthAddress      map[wallet.BackendID]wallet.Address
	USDCAsset       channel.Asset
	ContractBackend ethchannel.ContractBackend
	Funder          *ethchannel.Funder
	Adjudicator     *ethchannel.Adjudicator
	Cfg             *Config
	Log             *logrus.Logger
}

// NewPerunNode — LocalBus 기반 초기화 (P2P 없음)
func NewPerunNode(cfg *Config, log *logrus.Logger) (*PerunNode, error) {
	log.WithFields(logrus.Fields{
		"rpc":          cfg.RPCURL,
		"chain_id":     cfg.ChainID,
		"adjudicator":  cfg.AdjudicatorAddr.Hex(),
		"asset_holder": cfg.AssetHolderAddr.Hex(),
	}).Info("[Setup] Initializing go-perun node")

	// Step 1: 개인키 + simple wallet
	privKey, err := crypto.HexToECDSA(cfg.OperatorPrivKey)
	if err != nil {
		return nil, fmt.Errorf("parsing operator private key: %w", err)
	}
	w            := swallet.NewWallet(privKey)
	operatorAddr := crypto.PubkeyToAddress(privKey.PublicKey)
	operatorAcc  := accounts.Account{Address: operatorAddr}
	eaddr        := ethwallet.AsWalletAddr(operatorAddr)
	log.WithField("operator", operatorAddr.Hex()).Info("[Setup] ✓ wallet loaded")

	// Step 2: ContractBackend
	cb, err := newContractBackend(cfg.RPCURL, cfg.ChainID, w)
	if err != nil {
		return nil, fmt.Errorf("creating contract backend: %w", err)
	}
	log.Info("[Setup] ✓ contract backend created")

	// Step 3: 컨트랙트 검증
	if err := ethchannel.ValidateAdjudicator(context.Background(), cb, cfg.AdjudicatorAddr); err != nil {
		return nil, fmt.Errorf("Adjudicator 검증 실패 (%s): %w", cfg.AdjudicatorAddr.Hex(), err)
	}
	if err := ethchannel.ValidateAssetHolderERC20(
		context.Background(), cb,
		cfg.AssetHolderAddr, cfg.AdjudicatorAddr, cfg.USDCTokenAddr,
	); err != nil {
		return nil, fmt.Errorf("AssetHolderERC20 검증 실패 (%s): %w", cfg.AssetHolderAddr.Hex(), err)
	}
	log.Info("[Setup] ✓ contracts validated")

	// Step 4: Funder + ERC20Depositor
	funder    := ethchannel.NewFunder(cb)
	usdcAsset := ethchannel.NewAsset(new(big.Int).SetUint64(cfg.ChainID), cfg.AssetHolderAddr)
	funder.RegisterAsset(*usdcAsset, ethchannel.NewERC20Depositor(cfg.USDCTokenAddr, 300_000), operatorAcc)
	log.WithField("asset", cfg.AssetHolderAddr.Hex()).Info("[Setup] ✓ ERC20 funder registered")

	// Step 5: Adjudicator
	adj := ethchannel.NewAdjudicator(cb, cfg.AdjudicatorAddr, cfg.ReceiverAddr, operatorAcc, 1_000_000)
	log.Info("[Setup] ✓ adjudicator created")

	// Step 6: Dispute Watcher
	watcher, err := local.NewWatcher(adj)
	if err != nil {
		return nil, fmt.Errorf("initializing dispute watcher: %w", err)
	}
	log.Info("[Setup] ✓ dispute watcher initialized")

	// Step 7: ★ LocalBus (P2P 없음 — 동일 프로세스 내 인메모리 통신)
	bus := wire.NewLocalBus()
	log.Info("[Setup] ✓ LocalBus initialized (no P2P)")

	// Step 8: operator wire 주소 — ethwire.Address 래퍼 사용
	operatorWireKey, err := crypto.GenerateKey()
	if err != nil {
		return nil, fmt.Errorf("generating operator wire key: %w", err)
	}
	operatorEthAddr := ethwallet.AsWalletAddr(crypto.PubkeyToAddress(operatorWireKey.PublicKey))
	operatorWireAddr := &ethwire.Address{Address: operatorEthAddr}
	wireAddrs := map[wallet.BackendID]wire.Address{ethwallet.BackendID: operatorWireAddr}

	// Step 9: go-perun Client 조립
	wallets := map[wallet.BackendID]wallet.Wallet{ethwallet.BackendID: w}
	eAddrs  := map[wallet.BackendID]wallet.Address{ethwallet.BackendID: eaddr}

	perunClient, err := client.New(wireAddrs, bus, funder, adj, wallets, watcher)
	if err != nil {
		return nil, errors.WithMessage(err, "creating go-perun client")
	}
	log.Info("[Setup] ✅ go-perun client ready")

	return &PerunNode{
		Client:          perunClient,
		Bus:             bus,
		OperatorAddr:    operatorAddr,
		OperatorAccount: operatorAcc,
		WireAddress:     wireAddrs,
		EthAddress:      eAddrs,
		USDCAsset:       usdcAsset,
		ContractBackend: cb,
		Funder:          funder,
		Adjudicator:     adj,
		Cfg:             cfg,
		Log:             log,
	}, nil
}

// DeployContracts — 최초 1회 배포
type DeployedAddrs struct {
	AdjudicatorAddr common.Address
	AssetHolderAddr common.Address
}

func DeployContracts(ctx context.Context, cfg *Config, log *logrus.Logger) (*DeployedAddrs, error) {
	privKey, _ := crypto.HexToECDSA(cfg.OperatorPrivKey)
	w          := swallet.NewWallet(privKey)
	deployer   := accounts.Account{Address: crypto.PubkeyToAddress(privKey.PublicKey)}
	cb, err    := newContractBackend(cfg.RPCURL, cfg.ChainID, w)
	if err != nil { return nil, err }

	adjAddr, err := ethchannel.DeployAdjudicator(ctx, cb, deployer)
	if err != nil { return nil, fmt.Errorf("Adjudicator 배포 실패: %w", err) }
	log.WithField("addr", adjAddr.Hex()).Info("[Deploy] ✓ Adjudicator deployed")

	assetAddr, err := ethchannel.DeployERC20Assetholder(ctx, cb, adjAddr, cfg.USDCTokenAddr, deployer)
	if err != nil { return nil, fmt.Errorf("AssetHolderERC20 배포 실패: %w", err) }
	log.WithField("addr", assetAddr.Hex()).Info("[Deploy] ✓ AssetHolderERC20 deployed")

	return &DeployedAddrs{AdjudicatorAddr: adjAddr, AssetHolderAddr: assetAddr}, nil
}

// newContractBackend — ethclient + swallet.Transactor → ContractBackend
// ★ backgroundChainReader로 래핑: SubscribeNewHead가 gRPC deadline에 의해
//    취소되지 않도록 context를 Background()로 고정
func newContractBackend(rpcURL string, chainID uint64, w *swallet.Wallet) (ethchannel.ContractBackend, error) {
	ec, err := ethclient.Dial(rpcURL)
	if err != nil {
		return ethchannel.ContractBackend{}, fmt.Errorf("ethclient.Dial: %w", err)
	}
	bgClient := &backgroundChainReader{Client: ec}
	signer   := types.NewLondonSigner(new(big.Int).SetUint64(chainID))
	tr       := swallet.NewTransactor(w, signer)
	cid      := ethchannel.MakeChainID(new(big.Int).SetUint64(chainID))
	return ethchannel.NewContractBackend(bgClient, cid, tr, 1), nil
}
