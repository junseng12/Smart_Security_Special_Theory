// SmartCity Go-Perun Node — 진입점
//
// 시작 순서:
//   1) 환경변수 로드
//   2) setup.NewPerunNode() — perun-eth-backend 기반 실제 초기화
//   3) Manager / Orchestrator 조립
//   4) HTTP 헬스체크 서버 시작 (Railway용, PORT 환경변수)
//   5) gRPC 서버 시작
//
// 환경변수:
//   BASE_RPC_URL        — wss://... (Alchemy Base Sepolia)
//   CHAIN_ID            — 84532 (Base Sepolia)
//   OPERATOR_PRIVKEY    — hex 개인키 (0x 없이)
//   ADJUDICATOR_ADDR    — perun-eth-contracts Adjudicator 주소
//   ASSET_HOLDER_ADDR   — perun-eth-contracts AssetHolderERC20 주소
//   USDC_TOKEN_ADDR     — 0x036CbD53842c5426634e7929541eC2318f3dCF7e (Base Sepolia)
//   RECEIVER_ADDR       — 운영자 수령 주소
//   GRPC_PORT           — 기본 50051
//   PORT                — Railway 자동 주입 HTTP 포트 (헬스체크용)
//   DEPLOY_CONTRACTS    — "true" 이면 컨트랙트 배포 후 종료
package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strconv"

	"github.com/ethereum/go-ethereum/common"
	"github.com/sirupsen/logrus"

	"smartcity/go-perun-node/internal/audit"
	"smartcity/go-perun-node/internal/channel"
	"smartcity/go-perun-node/internal/refund"
	"smartcity/go-perun-node/internal/session"
	"smartcity/go-perun-node/internal/setup"
	"smartcity/go-perun-node/internal/transport"
)

func main() {
	log := logrus.New()
	log.SetFormatter(&logrus.JSONFormatter{})

	// ── 환경변수 로드 ────────────────────────────────────────────────
	cfg := &setup.Config{
		RPCURL:          mustEnv("BASE_RPC_URL"),
		ChainID:         mustEnvUint64("CHAIN_ID", 84532),
		OperatorPrivKey: mustEnv("OPERATOR_PRIVKEY"),
		AdjudicatorAddr: common.HexToAddress(mustEnv("ADJUDICATOR_ADDR")),
		AssetHolderAddr: common.HexToAddress(mustEnv("ASSET_HOLDER_ADDR")),
		USDCTokenAddr:   common.HexToAddress(envOr("USDC_TOKEN_ADDR", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")),
		ReceiverAddr:    common.HexToAddress(mustEnv("RECEIVER_ADDR")),
		TxFinalityDepth: 1,
	}

	// ── 컨트랙트 배포 모드 ────────────────────────────────────────────
	if os.Getenv("DEPLOY_CONTRACTS") == "true" {
		deployCfg := *cfg
		deployCfg.AdjudicatorAddr = common.Address{}
		deployCfg.AssetHolderAddr = common.Address{}
		addrs, err := setup.DeployContracts(context.Background(), &deployCfg, log)
		if err != nil {
			log.WithError(err).Fatal("contract deployment failed")
		}
		fmt.Printf("\n✅ 배포 완료\n")
		fmt.Printf("ADJUDICATOR_ADDR=%s\n", addrs.AdjudicatorAddr.Hex())
		fmt.Printf("ASSET_HOLDER_ADDR=%s\n", addrs.AssetHolderAddr.Hex())
		fmt.Println("\nRailway 환경변수에 위 값을 등록 후 재시작하세요.")
		os.Exit(0)
	}

	// ── go-perun 노드 초기화 (perun-eth-backend) ─────────────────────
	log.Info("Initializing go-perun node (perun-eth-backend)...")
	node, err := setup.NewPerunNode(cfg, log)
	if err != nil {
		log.WithError(err).Fatal("Failed to initialize perun node")
	}

	// ── 매니저 조립 ──────────────────────────────────────────────────
	sessionMgr := session.NewManager(log)
	channelMgr := channel.NewManager(node, cfg, log)
	refundMgr  := refund.NewManager(log)
	auditLog   := audit.NewLogger(log)

	channelMgr.StartHandling()

	orch := channel.NewOrchestrator(channelMgr, sessionMgr, refundMgr, auditLog, log)

	// ── HTTP 헬스체크 서버 (Railway PORT 환경변수) ────────────────────
	// Railway는 서비스가 PORT로 HTTP 응답해야 healthy로 인식함
	httpPort := envOr("PORT", "8080")
	go func() {
		mux := http.NewServeMux()
		mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"ok","service":"go-perun-node"}`))
		})
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			w.Write([]byte(`{"status":"ok"}`))
		})
		log.WithField("port", httpPort).Info("[HTTP] health server listening")
		if err := http.ListenAndServe(":"+httpPort, mux); err != nil {
			log.WithError(err).Warn("[HTTP] health server error")
		}
	}()

	// ── gRPC 서버 시작 ────────────────────────────────────────────────
	grpcPort := envInt("GRPC_PORT", 50051)
	srv := transport.New(orch, refundMgr, auditLog, log)

	log.WithField("port", grpcPort).Info("Starting gRPC server...")
	if err := transport.Serve(grpcPort, srv); err != nil {
		log.WithError(err).Fatal("gRPC server failed")
	}
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		logrus.Fatalf("missing required env: %s", key)
	}
	return v
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" { return v }
	return def
}

func mustEnvUint64(key string, def uint64) uint64 {
	v := os.Getenv(key)
	if v == "" { return def }
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil { return def }
	return n
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" { return def }
	n, _ := strconv.Atoi(v)
	return n
}
