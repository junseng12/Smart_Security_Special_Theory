// Package setup — perun-eth-backend v0.6.0 + go-perun v0.15.0 기준 초기화
// ★ LocalBus 전환: libp2p P2P 제거, 동일 프로세스 내 인메모리 버스 사용
// ★ Dual-client: HTTP(TX 전송) + WSS(이벤트 구독) 분리
package setup

import (
	"context"
	"fmt"
	"math/big"
	"strings"

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
	RPCURL          string // WSS URL (wss://...) — 이벤트 구독용
	HTTPRPCURL      string // HTTP URL (https://...) — TX 전송용 (선택, 미설정 시 RPCURL 사용)
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
	Bus             *wire.LocalBus
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

// wssToHTTPS — wss:// → https:// 변환 (HTTP fallback용)
func wssToHTTPS(url string) string {
	url = strings.Replace(url, "wss://", "https://", 1)
	url = strings.Replace(url, "ws://", "http://", 1)
	return url
}

// NewPerunNode — LocalBus 기반 초기화 (P2P 없음)
// ★ WSS client for event subscription, HTTP client for TX sending
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
	// ★ WSS URL → ethclient (WatchLogs 지원)
	// ★ 연결 context는 Background() 사용 — gRPC deadline과 완전 분리
	cb, err := newContractBackend(cfg.RPCURL, cfg.ChainID, w)
	if err != nil {
		// WSS 실패 시 HTTP fallback 시도
		httpURL := cfg.HTTPRPCURL
		if httpURL == "" {
			httpURL = wssToHTTPS(cfg.RPCURL)
		}
		log.WithError(err).Warnf("[Setup] WSS 연결 실패, HTTP fallback 시도: %s", httpURL)
		cb, err = newContractBackend(httpURL, cfg.ChainID, w)
		if err != nil {
			return nil, fmt.Errorf("creating contract backend: %w", err)
		}
	}
	log.Info("[Setup] ✓ contract backend created")

	// Step 3: 컨트랙트 검증 (Background context — 초기화 단계라 deadline 없음)
	bgCtx := context.Background()
	if err := ethchannel.ValidateAdjudicator(bgCtx, cb, cfg.AdjudicatorAddr); err != nil {
		return nil, fmt.Errorf("Adjudicator 검증 실패 (%s): %w", cfg.AdjudicatorAddr.Hex(), err)
	}
	if err := ethchannel.ValidateAssetHolderERC20(
		bgCtx, cb,
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

	// Step 7: LocalBus
	bus := wire.NewLocalBus()
	log.Info("[Setup] ✓ LocalBus initialized (no P2P)")

	// Step 8: operator wire 주소
	operatorWireKey, err := crypto.GenerateKey()
	if err != nil {
		return nil, fmt.Errorf("generating operator wire key: %w", err)
	}
	operatorEthAddr  := ethwallet.AsWalletAddr(crypto.PubkeyToAddress(operatorWireKey.PublicKey))
	operatorWireAddr := &ethwire.Address{Address: operatorEthAddr}
	wireAddrs        := map[wallet.BackendID]wire.Address{ethwallet.BackendID: operatorWireAddr}

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

// newContractBackend — ethclient.Dial + swallet.Transactor → ContractBackend
// ★ Background context 사용 — gRPC deadline과 분리
func newContractBackend(rpcURL string, chainID uint64, w *swallet.Wallet) (ethchannel.ContractBackend, error) {
	// ★ DialContext with Background — WSS 연결이 gRPC deadline에 영향받지 않도록
	ec, err := ethclient.DialContext(context.Background(), rpcURL)
	if err != nil {
		return ethchannel.ContractBackend{}, fmt.Errorf("ethclient.Dial(%s): %w", rpcURL, err)
	}
	signer := types.NewLondonSigner(new(big.Int).SetUint64(chainID))
	tr     := swallet.NewTransactor(w, signer)
	cid    := ethchannel.MakeChainID(new(big.Int).SetUint64(chainID))
	return ethchannel.NewContractBackend(ec, cid, tr, 1), nil
}
