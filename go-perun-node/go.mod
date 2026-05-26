module smartcity/go-perun-node

go 1.22

require (
	// ── go-perun SDK (설계도 — 인터페이스 정의) ─────────────────────
	perun.network/go-perun v0.12.1-0.20250128081648-21d0af4e234b

	// ── perun-eth-backend (실제 구현체 — 우리가 직접 사용) ───────────
	github.com/hyperledger-labs/perun-eth-backend v0.0.0-00010101000000-000000000000

	// ── Ethereum ─────────────────────────────────────────────────────
	github.com/ethereum/go-ethereum v1.10.12

	// ── 유틸 ──────────────────────────────────────────────────────────
	github.com/google/uuid v1.6.0
	github.com/pkg/errors v0.9.1
	github.com/sirupsen/logrus v1.8.1
	google.golang.org/grpc v1.63.2
	google.golang.org/protobuf v1.36.6
	polycry.pt/poly-go v0.0.0-20220301085937-fb9d71b45a37
)

// perun-eth-backend는 hyperledger-labs 저장소를 직접 사용
replace github.com/hyperledger-labs/perun-eth-backend => github.com/perun-network/perun-eth-backend v0.0.0-20250101000000-000000000000

// go-perun도 hyperledger-labs 포크 사용
replace perun.network/go-perun => github.com/hyperledger-labs/go-perun v0.12.1-0.20250128081648-21d0af4e234b
