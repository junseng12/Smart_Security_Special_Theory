package setup

import (
	"bytes"
	"testing"

	"github.com/ethereum/go-ethereum/common"
	ethwallet "github.com/perun-network/perun-eth-backend/wallet"
	ethwire "github.com/perun-network/perun-eth-backend/wire"
	"perun.network/go-perun/wire"
	"perun.network/go-perun/wire/perunio"
)

func TestEthereumWireAddressDecoderAllocatesEmbeddedAddress(t *testing.T) {
	configureEthereumWireAddressDecoder()

	walletAddress := ethwallet.AsWalletAddr(common.HexToAddress("0x1234567890123456789012345678901234567890"))
	original := &ethwire.Address{Address: walletAddress}
	var encoded bytes.Buffer
	if err := perunio.Encode(&encoded, original); err != nil {
		t.Fatalf("encode address: %v", err)
	}

	decoded := wire.NewAddress()
	if err := perunio.Decode(&encoded, decoded); err != nil {
		t.Fatalf("decode address: %v", err)
	}
	if !decoded.Equal(original) {
		t.Fatalf("decoded address %v does not equal original %v", decoded, original)
	}
}
