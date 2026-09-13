package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
	ethchannel "github.com/perun-network/perun-eth-backend/channel"
	ethwallet "github.com/perun-network/perun-eth-backend/wallet"
	"github.com/perun-network/perun-eth-backend/wallet/simple"
	"perun.network/go-perun/channel"
	"perun.network/go-perun/wallet"

	"smartcity/go-perun-node/internal/paymentapp"
)

type request struct {
	OperatorKey   string `json:"operatorKey"`
	UserKey       string `json:"userKey"`
	EscrowAddress string `json:"escrowAddress"`
	EscrowID      string `json:"escrowId"`
	UserAddress   string `json:"userAddress"`
	ChainID       string `json:"chainId"`
	Deposit       string `json:"deposit"`
	Fare          string `json:"fare"`
	Nonce         string `json:"nonce"`
	Version       uint64 `json:"version"`
	Final         *bool  `json:"final,omitempty"`
}

type response struct {
	ParamsABI    string   `json:"paramsABI"`
	StateABI     string   `json:"stateABI"`
	Signatures   []string `json:"signatures"`
	StateHash    string   `json:"stateHash"`
	ChannelID    string   `json:"channelId"`
	OperatorAddr string   `json:"operatorAddress"`
	UserAddr     string   `json:"userCustodialAddress"`
}

func main() {
	var req request
	if err := json.NewDecoder(os.Stdin).Decode(&req); err != nil {
		die(err)
	}
	out, err := build(req)
	if err != nil {
		die(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		die(err)
	}
}

func build(req request) (*response, error) {
	opKey, err := crypto.HexToECDSA(strings.TrimPrefix(req.OperatorKey, "0x"))
	if err != nil {
		return nil, fmt.Errorf("operator key: %w", err)
	}
	userKey, err := crypto.HexToECDSA(strings.TrimPrefix(req.UserKey, "0x"))
	if err != nil {
		return nil, fmt.Errorf("user key: %w", err)
	}
	opAddr := crypto.PubkeyToAddress(opKey.PublicKey)
	userCustodialAddr := crypto.PubkeyToAddress(userKey.PublicKey)
	parts := []map[wallet.BackendID]wallet.Address{
		{ethwallet.BackendID: ethwallet.AsWalletAddr(opAddr)},
		{ethwallet.BackendID: ethwallet.AsWalletAddr(userCustodialAddr)},
	}
	nonce, ok := new(big.Int).SetString(nonempty(req.Nonce, "1"), 10)
	if !ok {
		return nil, fmt.Errorf("invalid nonce")
	}
	app := paymentapp.New(common.HexToAddress(req.EscrowAddress))
	params, err := channel.NewParams(120, parts, app, nonce, true, false, channel.ZeroAux)
	if err != nil {
		return nil, err
	}
	chainID, ok := new(big.Int).SetString(nonempty(req.ChainID, "31337"), 10)
	if !ok {
		return nil, fmt.Errorf("invalid chain id")
	}
	deposit, ok := new(big.Int).SetString(req.Deposit, 10)
	if !ok {
		return nil, fmt.Errorf("invalid deposit")
	}
	fare, ok := new(big.Int).SetString(req.Fare, 10)
	if !ok {
		return nil, fmt.Errorf("invalid fare")
	}
	var escrowID [32]byte
	rawEscrow, err := hex.DecodeString(strings.TrimPrefix(req.EscrowID, "0x"))
	if err != nil || len(rawEscrow) != 32 {
		return nil, fmt.Errorf("escrowId must be 32 bytes")
	}
	copy(escrowID[:], rawEscrow)
	alloc := channel.NewAllocation(2, []wallet.BackendID{ethwallet.BackendID}, ethchannel.NewAsset(chainID, common.Address{}))
	alloc.SetAssetBalances(alloc.Assets[0], []channel.Bal{big.NewInt(0), big.NewInt(0)})
	isFinal := true
	if req.Final != nil {
		isFinal = *req.Final
	}
	state := &channel.State{
		ID:         params.ID(),
		Version:    req.Version,
		App:        app,
		Allocation: *alloc,
		Data: &paymentapp.Data{
			EscrowID:      escrowID,
			FareWei:       fare,
			ChainID:       chainID,
			EscrowAddress: common.HexToAddress(req.EscrowAddress),
			UserAddress:   common.HexToAddress(req.UserAddress),
			DepositWei:    deposit,
		},
		IsFinal: isFinal,
	}
	sw := simple.NewWallet(opKey, userKey)
	opAcc, err := sw.Unlock(ethwallet.AsWalletAddr(opAddr))
	if err != nil {
		return nil, err
	}
	userAcc, err := sw.Unlock(ethwallet.AsWalletAddr(userCustodialAddr))
	if err != nil {
		return nil, err
	}
	opSig, err := ethchannel.Sign(opAcc, state)
	if err != nil {
		return nil, err
	}
	userSig, err := ethchannel.Sign(userAcc, state)
	if err != nil {
		return nil, err
	}
	ethParams, ethState := ethchannel.ToEthParams(params), ethchannel.ToEthState(state)
	paramsABI, err := ethchannel.EncodeParams(&ethParams)
	if err != nil {
		return nil, err
	}
	stateABI, err := ethchannel.EncodeState(&ethState)
	if err != nil {
		return nil, err
	}
	id := params.ID()
	return &response{
		ParamsABI:    "0x" + hex.EncodeToString(paramsABI),
		StateABI:     "0x" + hex.EncodeToString(stateABI),
		Signatures:   []string{"0x" + hex.EncodeToString(opSig), "0x" + hex.EncodeToString(userSig)},
		StateHash:    fmt.Sprintf("0x%x", ethchannel.HashState(state)),
		ChannelID:    fmt.Sprintf("0x%x", id),
		OperatorAddr: opAddr.Hex(),
		UserAddr:     userCustodialAddr.Hex(),
	}, nil
}

func nonempty(v, fallback string) string {
	if v == "" {
		return fallback
	}
	return v
}

func die(err error) {
	_, _ = fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
