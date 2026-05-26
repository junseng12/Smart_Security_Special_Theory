module smartcity/go-perun-node

go 1.23.0

require (
	perun.network/go-perun v0.11.1
	github.com/perun-network/perun-eth-backend v0.4.0
	github.com/ethereum/go-ethereum v1.13.14
	github.com/google/uuid v1.6.0
	github.com/pkg/errors v0.9.1
	github.com/sirupsen/logrus v1.9.3
	google.golang.org/grpc v1.63.2
	google.golang.org/protobuf v1.36.6
	github.com/lib/pq v1.10.9
	github.com/redis/go-redis/v9 v9.5.1
)

replace perun.network/go-perun => github.com/hyperledger-labs/go-perun v0.11.1
