// orchestrator.go — SmartCity 비즈니스 로직 포장지
package channel

import (
	"context"
	"encoding/hex"
	"fmt"
	"github.com/ethereum/go-ethereum/crypto"
	"math/big"
	"smartcity/go-perun-node/internal/paymentapp"
	"smartcity/go-perun-node/internal/pricing"
	"strings"
	"time"

	"github.com/pkg/errors"
	"github.com/sirupsen/logrus"

	"smartcity/go-perun-node/internal/audit"
	"smartcity/go-perun-node/internal/refund"
	"smartcity/go-perun-node/internal/session"
)

type Orchestrator struct {
	channels *Manager
	sessions *session.Manager
	refunds  *refund.Manager
	audit    *audit.Logger
	log      *logrus.Logger
}

func NewOrchestrator(ch *Manager, sess *session.Manager, ref *refund.Manager, aud *audit.Logger, log *logrus.Logger) *Orchestrator {
	return &Orchestrator{channels: ch, sessions: sess, refunds: ref, audit: aud, log: log}
}

type StartRequest struct {
	ExternalSessionID string
	EscrowID          string
	UserAddress       string
	ServiceID         string
	DepositUsdc       string
	UserWireAddr      interface{}
	HoldSeconds       int64
}

type StartResult struct {
	SessionID    string
	ChannelID    string
	EscrowID     string
	HoldDeadline int64
	StateHash    string
}

func (o *Orchestrator) StartSessionAndOpen(ctx context.Context, req StartRequest) (*StartResult, error) {
	expected := crypto.Keccak256Hash([]byte(req.ExternalSessionID))
	raw, err := hex.DecodeString(strings.TrimPrefix(req.EscrowID, "0x"))
	if req.ExternalSessionID == "" || err != nil || len(raw) != 32 || !strings.EqualFold(req.EscrowID, expected.Hex()) {
		return nil, fmt.Errorf("external session ID and canonical escrow ID required")
	}
	sess, err := o.sessions.Start(ctx, req.ExternalSessionID, req.UserAddress, req.ServiceID, req.DepositUsdc)
	if err != nil {
		return nil, errors.Wrap(err, "starting session")
	}

	holdDeadline := time.Now().Unix() + max64(req.HoldSeconds, 120)

	openRes, err := o.channels.OpenChannel(ctx, OpenParams{
		SessionID:    sess.ID,
		EscrowID:     expected,
		UserAddress:  req.UserAddress,
		DepositUsdc:  req.DepositUsdc,
		HoldDeadline: holdDeadline,
	})
	if err != nil {
		return nil, errors.Wrap(err, "opening channel")
	}

	escrowID := expected.Hex()
	o.sessions.LinkChannel(sess.ID, openRes.ChannelID, escrowID, holdDeadline) //nolint:errcheck
	o.audit.Log(ctx, audit.ActionChannelOpen, openRes.ChannelID, sess.ID, map[string]any{
		"deposit_usdc": req.DepositUsdc,
	})

	return &StartResult{
		SessionID: sess.ID, ChannelID: openRes.ChannelID,
		EscrowID: escrowID, HoldDeadline: holdDeadline, StateHash: openRes.StateHash,
	}, nil
}

type ChargeReq struct {
	SessionID       string
	ChannelID       string
	ServiceType     string
	DurationMinutes float64
	EnergyKwh       float64
}

func (o *Orchestrator) ChargeUsage(ctx context.Context, req ChargeReq) (*ChargeResult, error) {
	h, err := o.channels.get(req.ChannelID)
	if err != nil {
		return nil, err
	}
	if h.SessionID != req.SessionID {
		return nil, fmt.Errorf("session/channel mismatch")
	}
	res, err := o.channels.ChargeUsage(ctx, ChargeRequest{
		ChannelID:       req.ChannelID,
		ServiceType:     req.ServiceType,
		DurationMinutes: req.DurationMinutes,
		EnergyKwh:       req.EnergyKwh,
	})
	if err != nil {
		return nil, err
	}
	o.sessions.AccumulateCharge(req.SessionID, res.FareUsdc) //nolint:errcheck
	o.audit.Log(ctx, audit.ActionUsageCharge, req.ChannelID, req.SessionID, map[string]any{
		"fare_usdc": res.FareUsdc, "nonce": res.NewNonce,
	})
	return res, nil
}

type EndRequest struct{ SessionID, ChannelID, UserAddress string }
type EndResult struct {
	FareUsdc, RefundUsdc string
	SettledAt            time.Time
	Proof                *paymentapp.Proof
}

func (o *Orchestrator) EndSessionAndSettle(ctx context.Context, req EndRequest) (*EndResult, error) {
	proof, err := o.channels.ExportFinal(ctx, req.ChannelID)
	if err != nil {
		h, e := o.channels.get(req.ChannelID)
		if e != nil {
			return nil, fmt.Errorf("no live channel or persisted final proof; refusing fare fallback: %w", e)
		}
		if h.SessionID != req.SessionID || !strings.EqualFold(h.UserAddress, req.UserAddress) {
			return nil, fmt.Errorf("session/channel/user mismatch")
		}
		_, err = o.channels.FinalUpdateAndAdjust(ctx, req.ChannelID, o.refunds.GetTotal(req.ChannelID))
		if err != nil {
			return nil, err
		}
		proof, err = o.channels.ExportFinal(ctx, req.ChannelID)
		if err != nil {
			return nil, err
		}
	}
	if proof.Data.EscrowID != crypto.Keccak256Hash([]byte(req.SessionID)) || !strings.EqualFold(proof.Data.UserAddress.Hex(), req.UserAddress) {
		return nil, fmt.Errorf("proof/session/user mismatch")
	}
	o.sessions.End(req.SessionID)
	o.sessions.SetStatus(req.SessionID, session.StatusSettling)
	return &EndResult{FareUsdc: pricing.WeiToUsdc(proof.Data.FareWei), RefundUsdc: pricing.WeiToUsdc(new(big.Int).Sub(proof.Data.DepositWei, proof.Data.FareWei)), Proof: proof}, nil
}

func remainingUsdc(depositUsdc, fareUsdc string) string {
	var deposit, fare float64
	fmt.Sscanf(depositUsdc, "%f", &deposit)
	fmt.Sscanf(fareUsdc, "%f", &fare)
	remaining := deposit - fare
	if remaining < 0 {
		remaining = 0
	}
	return fmt.Sprintf("%.6f", remaining)
}

func max64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

type StatusResult struct {
	State       string
	BalanceUser string
	BalanceOp   string
	StateHash   string
	Nonce       uint64
}

func (o *Orchestrator) GetStatus(_ context.Context, channelID string) (*StatusResult, error) {
	h, err := o.channels.GetStatus(channelID)
	if err != nil {
		return nil, fmt.Errorf("channel not found: %w", err)
	}
	return &StatusResult{
		State:       "open",
		BalanceUser: pricing.WeiToUsdc(h.balanceUser),
		BalanceOp:   pricing.WeiToUsdc(h.balanceOp),
		StateHash:   h.latestStateHash,
		Nonce:       h.latestNonce,
	}, nil
}

func (o *Orchestrator) RegisterDispute(ctx context.Context, channelID string) error {
	o.log.WithField("channel_id", channelID).Warn("[Dispute] registering on-chain dispute")
	return o.channels.InitiateDispute(ctx, channelID)
}
