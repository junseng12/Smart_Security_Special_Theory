//go:build ignore

// deploy.go — perun-eth-contracts 배포 스크립트 (1회성 실행)
//
// 사용법:
//   export BASE_RPC_URL=https://sepolia.base.org
//   export OPERATOR_PRIVKEY=<your_hex_key>
//   export USDC_TOKEN_ADDR=0x036CbD53842c5426634e7929541eC2318f3dCF7e
//   go run contracts/scripts/deploy.go
//
// 출력된 주소를 Railway 환경변수에 등록:
//   ADJUDICATOR_ADDR, ASSET_HOLDER_ADDR
package main

import (
	"context"
	"fmt"
	"os"

	"github.com/ethereum/go-ethereum/common"
	"github.com/sirupsen/logrus"

	"smartcity/go-perun-node/internal/setup"
)

func main() {
	log := logrus.New()
	log.SetFormatter(&logrus.TextFormatter{FullTimestamp: true})

	cfg := &setup.Config{
		RPCURL:          os.Getenv("BASE_RPC_URL"),
		ChainID:         84532,
		OperatorPrivKey: os.Getenv("OPERATOR_PRIVKEY"),
		USDCTokenAddr:   common.HexToAddress(os.Getenv("USDC_TOKEN_ADDR")),
	}

	if cfg.RPCURL == "" || cfg.OperatorPrivKey == "" {
		fmt.Fprintln(os.Stderr, "ERROR: BASE_RPC_URL, OPERATOR_PRIVKEY 환경변수가 필요합니다")
		os.Exit(1)
	}

	addrs, err := setup.DeployContracts(context.Background(), cfg, log)
	if err != nil {
		log.WithError(err).Fatal("배포 실패")
	}

	fmt.Println("\n========================================")
	fmt.Println("✅ perun-eth-contracts 배포 완료")
	fmt.Println("========================================")
	fmt.Printf("ADJUDICATOR_ADDR=%s\n", addrs.AdjudicatorAddr.Hex())
	fmt.Printf("ASSET_HOLDER_ADDR=%s\n", addrs.AssetHolderAddr.Hex())
	fmt.Println("\nRailway 대시보드 → Variables에 위 값 등록 후 재배포하세요.")
	fmt.Println("========================================")
}
