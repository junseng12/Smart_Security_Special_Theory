// Package setup는 perun-eth-backend를 사용해 go-perun Client를 초기화합니다.
//
// ★ 핵심 역할:
//   go-perun (설계도 인터페이스) + perun-eth-backend (이더리움 구현체)를
//   연결하는 유일한 초기화 지점입니다.
//
// 참고 패턴:
//   perun-examples/payment-channel/client/client.go — SetupPaymentClient()
//   perun-examples/payment-channel/util.go          — CreateContractBackend()
package setup

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"math/big"
	"math/rand"
	"time"

	// ── Ethereum ────────────────────────────────────────────────────────
	"github.com/ethereum/go-ethereum/accounts"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/ethclient"

	// ── perun-eth-backend (실제 ETH 구현체) ────────────────────────────
	ethchannel "github.com/hyperledger-labs/perun-eth-backend/channel"
	ethwallet  "github.com/hyperledger-labs/perun-eth-backend/wallet"
	swallet    "github.com/hyperledger-labs/perun-eth-backend/wallet/simple"

	// ── go-perun SDK (인터페이스 + 공통 로직) ───────────────────────────
	"perun.network/go-perun/channel"
	"perun.network/go-perun/client"
	"perun.network/go-perun/wallet"
	"perun.network/go-perun/watcher/local"
	"perun.network/go-perun/wire"
	"perun.network/go-perun/wire/net"
	p2p "perun.network/go-perun/wire/net/libp2p"
	perunio "perun.network/go-perun/wire/perunio/serializer"

	"github.com/pkg/errors"
	"github.com/sirupsen/logrus"
)

// ────────────────────────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────────────────────────

type Config struct {
	RPCURL          string         // BASE_RPC_URL (예: https://sepolia.base.org)
	ChainID         uint64         // 84532 (Base Sepolia)
	OperatorPrivKey string         // OPERATOR_PRIVKEY (hex, 0x 없이)
	AdjudicatorAddr common.Address // ADJUDICATOR_ADDR
	AssetHolderAddr common.Address // ASSET_HOLDER_ADDR (AssetHolderERC20)
	USDCTokenAddr   common.Address // USDC_TOKEN_ADDR (0x036CbD5...)
	ReceiverAddr    common.Address // RECEIVER_ADDR (운영자 수령 주소)
	TxFinalityDepth uint64         // 기본 1
}

// ────────────────────────────────────────────────────────────────────
// PerunNode — 초기화 완료된 go-perun 노드
// ────────────────────────────────────────────────────────────────────

type PerunNode struct {
	// ★ 핵심 go-perun 클라이언트
	// ch.Update(), ch.Settle(), ProposeChannel() 등의 주체
	Client *client.Client

	// 운영자 계정
	OperatorAddr    common.Address
	OperatorAccount accounts.Account

	// Wire 주소 (P2P 통신 식별자, ProposeChannel에 사용)
	WireAddress map[wallet.BackendID]wire.Address
	EthAddress  map[wallet.BackendID]wallet.Address

	// USDC 에셋 (channel.Allocation에 등록)
	USDCAsset channel.Asset

	// 로우레벨 접근용
	ContractBackend ethchannel.ContractBackend

	Log *logrus.Logger
}

// ────────────────────────────────────────────────────────────────────
// NewPerunNode — 실제 초기화
// ────────────────────────────────────────────────────────────────────

func NewPerunNode(cfg *Config, log *logrus.Logger) (*PerunNode, error) {
	log.WithFields(logrus.Fields{
		"rpc":          cfg.RPCURL,
		"chain_id":     cfg.ChainID,
		"adjudicator":  cfg.AdjudicatorAddr.Hex(),
		"asset_holder": cfg.AssetHolderAddr.Hex(),
		"usdc":         cfg.USDCTokenAddr.Hex(),
	}).Info("[Setup] Initializing go-perun node (perun-eth-backend)")

	// ── Step 1: 개인키 파싱 + simple wallet 생성 ───────────────────────
	// swallet = perun-eth-backend/wallet/simple
	// 오프체인 서명(ch.Update) + 온체인 TX(ch.Settle) 모두 이 지갑 사용
	privKey, err := crypto.HexToECDSA(cfg.OperatorPrivKey)
	if err != nil {
		return nil, fmt.Errorf("parsing operator private key: %w", err)
	}
	w            := swallet.NewWallet(privKey)
	operatorAddr := crypto.PubkeyToAddress(privKey.PublicKey)
	operatorAcc  := accounts.Account{Address: operatorAddr}
	eaddr        := ethwallet.AsWalletAddr(operatorAddr)

	log.WithField("operator", operatorAddr.Hex()).Info("[Setup] ✓ wallet loaded")

	// ── Step 2: ContractBackend 생성 ───────────────────────────────────
	// ethclient.Dial + perun-eth-backend ContractBackend
	// 모든 온체인 TX(Fund, Register, Withdraw 등)가 이를 통해 전송됨
	cb, err := newContractBackend(cfg.RPCURL, cfg.ChainID, w)
	if err != nil {
		return nil, fmt.Errorf("creating contract backend: %w", err)
	}
	log.Info("[Setup] ✓ contract backend created")

	// ── Step 3: perun-eth-contracts 컨트랙트 검증 ─────────────────────
	// perun-eth-backend/channel/adjudicator.go: ValidateAdjudicator
	// perun-eth-backend/channel/funder.go:      ValidateAssetHolderERC20
	if err := ethchannel.ValidateAdjudicator(context.TODO(), cb, cfg.AdjudicatorAddr); err != nil {
		return nil, fmt.Errorf("Adjudicator 검증 실패 (%s): %w — 컨트랙트가 배포됐는지 확인하세요", cfg.AdjudicatorAddr.Hex(), err)
	}
	if err := ethchannel.ValidateAssetHolderERC20(context.TODO(), cb, cfg.AssetHolderAddr, cfg.AdjudicatorAddr); err != nil {
		return nil, fmt.Errorf("AssetHolderERC20 검증 실패 (%s): %w", cfg.AssetHolderAddr.Hex(), err)
	}
	log.Info("[Setup] ✓ contracts validated (Adjudicator + AssetHolderERC20)")

	// ── Step 4: Funder + ERC20Depositor ───────────────────────────────
	// ethchannel.Funder  = perun-eth-backend/channel/funder.go
	// ERC20Depositor     = perun-eth-backend/channel/erc20_depositor.go
	//   → approve(USDC → AssetHolder) + deposit(AssetHolder) 2개 TX 자동 처리
	funder   := ethchannel.NewFunder(cb)
	usdcAsset := ethchannel.NewAsset(
		new(big.Int).SetUint64(cfg.ChainID),
		cfg.AssetHolderAddr,
	)
	funder.RegisterAsset(
		*usdcAsset,
		ethchannel.NewERC20Depositor(cfg.USDCTokenAddr, 300_000), // gasLimit
		operatorAcc,
	)
	log.WithField("asset", cfg.AssetHolderAddr.Hex()).Info("[Setup] ✓ ERC20 funder registered")

	// ── Step 5: Adjudicator ────────────────────────────────────────────
	// ethchannel.Adjudicator = perun-eth-backend/channel/adjudicator.go
	//   → Register (분쟁 등록) + Withdraw (정산 후 자금 인출)
	// Receiver = 운영자 주소 (요금 수령)
	adj := ethchannel.NewAdjudicator(
		cb,
		cfg.AdjudicatorAddr,
		cfg.ReceiverAddr,
		operatorAcc,
		1_000_000, // gasLimit
	)
	log.Info("[Setup] ✓ adjudicator created")

	// ── Step 6: Dispute Watcher ────────────────────────────────────────
	// go-perun/watcher/local: 온체인 이벤트 감시
	// 상대방이 오래된 상태로 분쟁 등록 시 → 자동으로 최신 상태 제출
	watcher, err := local.NewWatcher(adj)
	if err != nil {
		return nil, fmt.Errorf("initializing dispute watcher: %w", err)
	}
	log.Info("[Setup] ✓ dispute watcher initialized")

	// ── Step 7: P2P Wire Bus (libp2p) ─────────────────────────────────
	// go-perun/wire/net/libp2p: 오프체인 메시지 교환 (채널 제안, 상태 업데이트 서명)
	rng       := rand.New(rand.NewSource(time.Now().UnixNano()))
	wireAcc   := p2p.NewRandomAccount(rng)
	listener  := p2p.NewP2PListener(wireAcc)
	dialer    := p2p.NewP2PDialer(wireAcc)

	wireID := map[wallet.BackendID]wire.Account{
		ethwallet.BackendID: wireAcc,
	}
	bus := net.NewBus(wireID, dialer, perunio.Serializer())
	go bus.Listen(listener)

	wireAddrs := map[wallet.BackendID]wire.Address{
		ethwallet.BackendID: wireAcc.Address(),
	}
	log.Info("[Setup] ✓ P2P wire bus started")

	// ── Step 8: go-perun Client 조립 ──────────────────────────────────
	// ★ 핵심: 설계도(go-perun) + 구현체(perun-eth-backend)의 만남
	//   client.New(wireAddr, bus, funder, adj, wallets, watcher)
	//     ↑ go-perun      ↑ go-perun  ↑ eth-backend  ↑ go-perun
	wallets := map[wallet.BackendID]wallet.Wallet{
		ethwallet.BackendID: w,
	}
	eAddrs := map[wallet.BackendID]wallet.Address{
		ethwallet.BackendID: eaddr,
	}

	perunClient, err := client.New(wireAddrs, bus, funder, adj, wallets, watcher)
	if err != nil {
		return nil, errors.WithMessage(err, "creating go-perun client")
	}
	log.Info("[Setup] ✅ go-perun client ready")

	return &PerunNode{
		Client:          perunClient,
		OperatorAddr:    operatorAddr,
		OperatorAccount: operatorAcc,
		WireAddress:     wireAddrs,
		EthAddress:      eAddrs,
		USDCAsset:       usdcAsset,
		ContractBackend: cb,
		Log:             log,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// DeployContracts — perun-eth-contracts 최초 배포 (1회성)
//
// 배포 순서:
//   1. Adjudicator.sol (perun-eth-contracts)
//   2. AssetHolderERC20.sol (perun-eth-contracts, USDC 전용)
//
// 출력된 주소를 Railway 환경변수에 등록:
//   ADJUDICATOR_ADDR, ASSET_HOLDER_ADDR
// ────────────────────────────────────────────────────────────────────

type DeployedAddrs struct {
	AdjudicatorAddr common.Address
	AssetHolderAddr common.Address
}

func DeployContracts(ctx context.Context, cfg *Config, log *logrus.Logger) (*DeployedAddrs, error) {
	log.Info("[Deploy] perun-eth-contracts → Base Sepolia 배포 시작")

	privKey, _ := crypto.HexToECDSA(cfg.OperatorPrivKey)
	w         := swallet.NewWallet(privKey)
	deployer  := accounts.Account{Address: crypto.PubkeyToAddress(privKey.PublicKey)}

	cb, err := newContractBackend(cfg.RPCURL, cfg.ChainID, w)
	if err != nil {
		return nil, err
	}

	// 1) Adjudicator (분쟁 판정 + conclude)
	adjAddr, err := ethchannel.DeployAdjudicator(ctx, cb, deployer)
	if err != nil {
		return nil, fmt.Errorf("Adjudicator 배포 실패: %w", err)
	}
	log.WithField("addr", adjAddr.Hex()).Info("[Deploy] ✓ Adjudicator deployed")

	// 2) AssetHolderERC20 (USDC 예치/출금)
	//    생성자: constructor(address adjudicator, address token)
	assetAddr, err := ethchannel.DeployERC20Assetholder(ctx, cb, adjAddr, cfg.USDCTokenAddr, deployer)
	if err != nil {
		return nil, fmt.Errorf("AssetHolderERC20 배포 실패: %w", err)
	}
	log.WithField("addr", assetAddr.Hex()).Info("[Deploy] ✓ AssetHolderERC20 deployed")

	log.WithFields(logrus.Fields{
		"ADJUDICATOR_ADDR":  adjAddr.Hex(),
		"ASSET_HOLDER_ADDR": assetAddr.Hex(),
	}).Info("[Deploy] ✅ 완료 — 아래 값을 Railway 환경변수에 등록하세요")

	return &DeployedAddrs{
		AdjudicatorAddr: adjAddr,
		AssetHolderAddr: assetAddr,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ────────────────────────────────────────────────────────────────────

func newContractBackend(rpcURL string, chainID uint64, w *swallet.Wallet) (ethchannel.ContractBackend, error) {
	ec, err := ethclient.Dial(rpcURL)
	if err != nil {
		return ethchannel.ContractBackend{}, fmt.Errorf("ethclient.Dial(%s): %w", rpcURL, err)
	}
	return ethchannel.NewContractBackend(
		ec,
		ethchannel.NewChainID(new(big.Int).SetUint64(chainID)),
		w,
		1, // txFinalityDepth = 1 (Base L2는 빠름)
	), nil
}
