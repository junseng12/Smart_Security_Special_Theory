// Package paymentapp defines escrow accounting carried by native Perun states.
package paymentapp

import (
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	ethchannel "github.com/perun-network/perun-eth-backend/channel"
	ethwallet "github.com/perun-network/perun-eth-backend/wallet"
	"perun.network/go-perun/channel"
)

// Data is ABI encoded in this exact order. Wei means USDC base units (10^-6).
// Domain and deposit fields are immutable through the channel's lifetime.
type Data struct {
	EscrowID      [32]byte
	FareWei       *big.Int
	ChainID       *big.Int
	EscrowAddress common.Address
	UserAddress   common.Address
	DepositWei    *big.Int
}

var dataABI = func() abi.Arguments {
	var args abi.Arguments
	for _, name := range []string{"bytes32", "uint256", "uint256", "address", "address", "uint256"} {
		t, err := abi.NewType(name, "", nil)
		if err != nil {
			panic(err)
		}
		args = append(args, abi.Argument{Type: t})
	}
	return args
}()

func (d *Data) Validate() error {
	if d == nil || d.EscrowID == [32]byte{} || d.EscrowAddress == (common.Address{}) || d.UserAddress == (common.Address{}) {
		return fmt.Errorf("invalid payment identity")
	}
	for _, n := range []*big.Int{d.FareWei, d.ChainID, d.DepositWei} {
		if n == nil || n.Sign() < 0 || n.BitLen() > 256 {
			return fmt.Errorf("invalid uint256 payment amount/domain")
		}
	}
	if d.ChainID.Sign() == 0 || d.DepositWei.Sign() == 0 || d.FareWei.Cmp(d.DepositWei) > 0 {
		return fmt.Errorf("invalid chain or fare exceeds deposit")
	}
	return nil
}
func (d *Data) MarshalBinary() ([]byte, error) {
	if err := d.Validate(); err != nil {
		return nil, err
	}
	return dataABI.Pack(d.EscrowID, d.FareWei, d.ChainID, d.EscrowAddress, d.UserAddress, d.DepositWei)
}
func (d *Data) UnmarshalBinary(b []byte) error {
	if len(b) != 192 {
		return fmt.Errorf("payment data must be exactly 192 bytes")
	}
	v, err := dataABI.Unpack(b)
	if err != nil {
		return err
	}
	next := Data{v[0].([32]byte), v[1].(*big.Int), v[2].(*big.Int), v[3].(common.Address), v[4].(common.Address), v[5].(*big.Int)}
	if err := next.Validate(); err != nil {
		return err
	}
	canonical, _ := next.MarshalBinary()
	for i := range b {
		if b[i] != canonical[i] {
			return fmt.Errorf("noncanonical payment encoding")
		}
	}
	*d = next
	return nil
}
func (d *Data) Clone() channel.Data {
	if d == nil {
		return nil
	}
	c := *d
	if d.FareWei != nil {
		c.FareWei = new(big.Int).Set(d.FareWei)
	}
	if d.ChainID != nil {
		c.ChainID = new(big.Int).Set(d.ChainID)
	}
	if d.DepositWei != nil {
		c.DepositWei = new(big.Int).Set(d.DepositWei)
	}
	return &c
}

type App struct{ id channel.AppID }

func New(address common.Address) *App {
	return &App{&ethchannel.AppID{Address: ethwallet.AsWalletAddr(address)}}
}
func (a *App) Def() channel.AppID  { return a.id }
func (*App) NewData() channel.Data { return &Data{} }
func (a *App) validate(p *channel.Params, s *channel.State) (*Data, error) {
	d, ok := s.Data.(*Data)
	if !ok {
		return nil, fmt.Errorf("unexpected payment data type")
	}
	if err := d.Validate(); err != nil {
		return nil, err
	}
	if len(p.Parts) != 2 || !p.LedgerChannel || p.VirtualChannel || !p.App.Def().Equal(a.id) {
		return nil, fmt.Errorf("invalid payment parameters")
	}
	if !New(d.EscrowAddress).Def().Equal(a.id) {
		return nil, fmt.Errorf("wrong escrow app")
	}
	if len(s.Locked) != 0 || len(s.Assets) != 1 || len(s.Backends) != 1 || s.Backends[0] != ethwallet.BackendID || len(s.Balances) != 1 || len(s.Balances[0]) != 2 {
		return nil, fmt.Errorf("invalid escrow allocation")
	}
	for _, b := range s.Balances[0] {
		if b == nil || b.Sign() != 0 {
			return nil, fmt.Errorf("escrow channel must have zero Perun balances")
		}
	}
	return d, nil
}
func (a *App) ValidInit(p *channel.Params, s *channel.State) error {
	d, err := a.validate(p, s)
	if err != nil {
		return err
	}
	if d.FareWei.Sign() != 0 || s.IsFinal {
		return fmt.Errorf("initial fare must be zero and nonfinal")
	}
	return nil
}
func (a *App) ValidTransition(p *channel.Params, from, to *channel.State, actor channel.Index) error {
	f, err := a.validate(p, from)
	if err != nil {
		return err
	}
	t, err := a.validate(p, to)
	if err != nil {
		return err
	}
	if actor != 0 || from.IsFinal || f.EscrowID != t.EscrowID || f.ChainID.Cmp(t.ChainID) != 0 || f.EscrowAddress != t.EscrowAddress || f.UserAddress != t.UserAddress || f.DepositWei.Cmp(t.DepositWei) != 0 {
		return fmt.Errorf("invalid payment transition identity/actor")
	}
	if !to.IsFinal && t.FareWei.Cmp(f.FareWei) < 0 {
		return fmt.Errorf("usage fare decreased")
	}
	if to.IsFinal && t.FareWei.Cmp(f.FareWei) > 0 {
		return fmt.Errorf("finalization cannot add unsigned usage")
	}
	return nil
}

var _ channel.StateApp = (*App)(nil)
var _ channel.Data = (*Data)(nil)
