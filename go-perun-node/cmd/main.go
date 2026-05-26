// SmartCity Go-Perun Node
// ─────────────────────────────────────────────────────────────────────────────
// go-perun SDK를 이용한 오프체인 결제 노드입니다.
// Node.js 백엔드가 gRPC로 이 노드를 호출합니다.
//
// 시작 순서:
//   1) go-perun Client 초기화 (ETH backend, Funder, Adjudicator, Watcher)
//   2) Session/Channel/Pricing/Refund/Audit 매니저 초기화
//   3) Orchestrator 조립
//   4) gRPC 서버 시작 (기본 포트 50051)
//
// 환경변수:
//   BASE_RPC_URL        — Base Sepolia RPC (예: https://sepolia.base.org)
//   OPERATOR_PRIVKEY    — 운영자 개인키 (hex, 0x 없이)
//   ADJUDICATOR_ADDR    — Perun Adjudicator 컨트랙트 주소
//   ASSET_HOLDER_ADDR   — USDC AssetHolder 컨트랙트 주소
//   GRPC_PORT           — gRPC 수신 포트 (기본 50051)
//   DB_URL              — PostgreSQL 연결 문자열
//   REDIS_URL           — Redis 연결 문자열
package main

import (
	"os"
	"strconv"

	"github.com/sirupsen/logrus"

	"smartcity/go-perun-node/internal/audit"
	"smartcity/go-perun-node/internal/channel"
	"smartcity/go-perun-node/internal/refund"
	"smartcity/go-perun-node/internal/session"
	"smartcity/go-perun-node/internal/transport"
)

func main() {
	log := logrus.New()
	log.SetFormatter(&logrus.JSONFormatter{})
	log.SetLevel(logrus.InfoLevel)

	log.Info("SmartCity Go-Perun Node starting...")

	// ── 환경변수 ───────────────────────────────────────────────────────────
	grpcPort := envInt("GRPC_PORT", 50051)

	// ── DB / Redis 초기화 ─────────────────────────────────────────────────
	// TODO: DB/Redis 클라이언트 초기화 (session.NewPostgresStore 등)
	// 현재는 인메모리 mock 사용
	log.Info("Initializing stores (in-memory mock for now)...")
	sessionStore := session.NewInMemoryStore()
	auditStore   := audit.NewInMemoryStore()

	// ── 매니저 초기화 ─────────────────────────────────────────────────────
	sessionMgr := session.NewManager(sessionStore, log)
	channelMgr := channel.NewManager(log)
	auditLogger := audit.NewLogger(auditStore, log)

	// Treasury (정산 후 환불용) — 현재 mock
	treasury   := refund.NewMockTreasury(log)
	refundMgr  := refund.NewManager(treasury, log)

	// ── go-perun Client 초기화 ────────────────────────────────────────────
	// ETH Backend: perun-eth-backend 사용
	// 필요 컨트랙트:
	//   - Adjudicator (분쟁/정산 중재자)
	//   - ETH/ERC20 AssetHolder (USDC 예치 컨트랙트)
	//
	// ★ 실제 go-perun 초기화 코드:
	//   cb := ethchannel.NewContractBackend(ethClient, chainID, operatorKey)
	//   funder := ethchannel.NewFunder(cb)
	//   funder.RegisterAsset(usdcAsset, ethchannel.NewERC20Depositor(), operatorAccount)
	//   adj := ethchannel.NewAdjudicator(cb, adjAddress, operatorAddr, operatorAccount, 1000000)
	//   watcher, _ := local.NewWatcher(adj)
	//   perunClient, _ := client.New(operatorWireAddr, bus, funder, adj, wallet, watcher)
	//   channelMgr.SetPerunClient(perunClient, operatorWireAddr, usdcAsset)
	//
	// 현재: 환경변수가 설정되지 않은 경우 mock 모드로 동작
	if err := initPerunClient(channelMgr, log); err != nil {
		log.WithError(err).Warn("go-perun client init failed — running in MOCK mode")
		log.Warn("Set BASE_RPC_URL, OPERATOR_PRIVKEY, ADJUDICATOR_ADDR, ASSET_HOLDER_ADDR for real Perun")
	}

	// ── Orchestrator 조립 ─────────────────────────────────────────────────
	orchestrator := channel.NewOrchestrator(sessionMgr, channelMgr, refundMgr, auditLogger, log)

	// ── gRPC 서버 시작 ────────────────────────────────────────────────────
	grpcServer := transport.NewGRPCServer(orchestrator, refundMgr, auditLogger, log)

	log.WithField("port", grpcPort).Info("Starting gRPC server...")
	if err := transport.Serve(grpcPort, grpcServer); err != nil {
		log.WithError(err).Fatal("gRPC server failed")
		os.Exit(1)
	}
}

// initPerunClient는 go-perun 클라이언트를 초기화합니다.
// 환경변수가 없으면 mock 모드로 동작합니다.
func initPerunClient(mgr *channel.Manager, log *logrus.Logger) error {
	rpcURL  := os.Getenv("BASE_RPC_URL")
	privKey := os.Getenv("OPERATOR_PRIVKEY")
	adjAddr := os.Getenv("ADJUDICATOR_ADDR")
	assetAddr := os.Getenv("ASSET_HOLDER_ADDR")

	if rpcURL == "" || privKey == "" || adjAddr == "" || assetAddr == "" {
		return nil // mock 모드
	}

	log.WithFields(logrus.Fields{
		"rpc":          rpcURL,
		"adjudicator":  adjAddr,
		"asset_holder": assetAddr,
	}).Info("Initializing go-perun ETH client...")

	// ── 실제 go-perun ETH 백엔드 초기화 (perun-eth-backend) ─────────────
	// import (
	//     ethchannel "github.com/perun-network/perun-eth-backend/channel"
	//     ethwallet "github.com/perun-network/perun-eth-backend/wallet"
	//     swallet "github.com/perun-network/perun-eth-backend/wallet/simple"
	//     "github.com/perun-network/perun-eth-backend/wire/net/libp2p"
	//     localwatcher "perun.network/go-perun/watcher/local"
	//     goclient "perun.network/go-perun/client"
	// )
	//
	// key, _ := crypto.HexToECDSA(privKey)
	// w := swallet.NewWallet()
	// acc, _ := w.ImportAccount(key)
	// ethAcc := accounts.Account{Address: crypto.PubkeyToAddress(key.PublicKey)}
	//
	// cb, _ := ethchannel.CreateContractBackend(rpcURL, chainID, w)
	// funder := ethchannel.NewFunder(cb)
	// usdcAsset := ethchannel.NewAsset(big.NewInt(chainID), common.HexToAddress(assetAddr))
	// dep := ethchannel.NewERC20Depositor(usdcAddress, 300000)
	// funder.RegisterAsset(*usdcAsset, dep, ethAcc)
	//
	// adj := ethchannel.NewAdjudicator(cb, common.HexToAddress(adjAddr), ethAcc.Address, ethAcc, 1000000)
	// watcher, _ := localwatcher.NewWatcher(adj)
	//
	// wireAcc := p2p.NewRandomAccount(...)
	// bus, _ := p2p.NewBus(wireAcc, ...)
	// wireAddrs := map[wallet.BackendID]wire.Address{ethwallet.BackendID: wireAcc.Address()}
	// wallets := map[wallet.BackendID]wallet.Wallet{ethwallet.BackendID: w}
	// perunClient, _ := goclient.New(wireAddrs, bus, funder, adj, wallets, watcher)
	//
	// mgr.SetPerunClient(perunClient, wireAddrs, usdcAsset)

	log.Info("go-perun ETH client initialized (stub — uncomment above for production)")
	return nil
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}
