package paymentapp

import (
	"fmt"
	ethchannel "github.com/perun-network/perun-eth-backend/channel"
	ethwallet "github.com/perun-network/perun-eth-backend/wallet"
	"perun.network/go-perun/channel"
)

// Proof contains unmodified official ABI encodings and native participant sigs.
type Proof struct {
	ParamsABI  []byte
	StateABI   []byte
	Signatures [][]byte
	StateHash  string
	Data       *Data
}

func Export(source channel.Source) (*Proof, error) {
	tx := source.CurrentTX()
	if tx.State == nil || !tx.State.IsFinal {
		return nil, fmt.Errorf("no persisted final state")
	}
	p := source.Params()
	d, ok := tx.State.Data.(*Data)
	if !ok {
		return nil, fmt.Errorf("not a payment state")
	}
	if _, err := New(d.EscrowAddress).validate(p, tx.State); err != nil {
		return nil, err
	}
	if tx.State.ID != p.ID() || len(tx.Sigs) != len(p.Parts) {
		return nil, fmt.Errorf("incomplete final transaction")
	}
	sigs := make([][]byte, len(tx.Sigs))
	for i, sig := range tx.Sigs {
		if len(sig) != ethwallet.SigLen {
			return nil, fmt.Errorf("missing native signature %d", i)
		}
		ok, err := ethchannel.Verify(p.Parts[i][ethwallet.BackendID], tx.State, sig)
		if err != nil || !ok {
			return nil, fmt.Errorf("invalid native signature %d", i)
		}
		sigs[i] = append([]byte(nil), sig...)
	}
	ep, es := ethchannel.ToEthParams(p), ethchannel.ToEthState(tx.State)
	pb, err := ethchannel.EncodeParams(&ep)
	if err != nil {
		return nil, err
	}
	sb, err := ethchannel.EncodeState(&es)
	if err != nil {
		return nil, err
	}
	return &Proof{pb, sb, sigs, fmt.Sprintf("0x%x", ethchannel.HashState(tx.State)), d.Clone().(*Data)}, nil
}
