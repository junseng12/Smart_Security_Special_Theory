// orchestrator.go — SmartCity 비즈니스 로직 포장지
// gRPC 서버 → Orchestrator → (channel.Manager + session.Manager + refund.Manager)
package channel

import (
	"context"
	"fmt"
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

// ── StartSession + OpenChannel ─────────────────────────────────────

type StartRequest struct {
	UserAddress  string
	ServiceID    string
	DepositUsdc  string
	UserWireAddr interface{} // map[wallet.BackendID]wire.Address
	HoldSeconds  int64
}

type StartResult struct {
	SessionID    string
	ChannelID    string
	EscrowID     string
	HoldDeadline int64
	StateHash    string
}

func (o *Orchestrator) StartSessionAndOpen(ctx context.Context, req StartRequest) (*StartResult, error) {
	// 1. 세션 생성
	sess, err := o.sessions.Start(ctx, req.UserAddress, req.ServiceID, req.DepositUsdc)
	if err != nil {
		return nil, errors.Wrap(err, "starting session")
	}

	holdDeadline := time.Now().Unix() + max64(req.HoldSeconds, 120)

	// 2. perun-eth-backend OpenChannel
	// (UserWireAddr는 실제 P2P 주소 — MetaMask 전용 모드에서는 별도 처리)
	openRes, err := o.channels.OpenChannel(ctx, OpenParams{
		SessionID:   sess.ID,
		UserAddress: req.UserAddress,
		DepositUsdc: req.DepositUsdc,
		HoldDeadline: holdDeadline,
		// UserWireAddr: req.UserWireAddr (실제 libp2p 주소)
	})
	if err != nil {
		return nil, errors.Wrap(err, "opening channel")
	}

	escrowID := fmt.Sprintf("0x%x", simpleHash(sess.ID))
	o.sessions.LinkChannel(sess.ID, openRes.ChannelID, escrowID, holdDeadline) //nolint:errcheck
	o.audit.Log(ctx, audit.ActionChannelOpen, openRes.ChannelID, sess.ID, map[string]any{
		"deposit_usdc": req.DepositUsdc,
	})

	return &StartResult{
		SessionID: sess.ID, ChannelID: openRes.ChannelID,
		EscrowID: escrowID, HoldDeadline: holdDeadline, StateHash: openRes.StateHash,
	}, nil
}

// ── ChargeUsage ───────────────────────────────────────────────────

type ChargeReq struct {
	SessionID       string
	ChannelID       string
	ServiceType     string
	DurationMinutes float64
	EnergyKwh       float64
}

func (o *Orchestrator) ChargeUsage(ctx context.Context, req ChargeReq) (*ChargeResult, error) {
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

// ── EndSession + Settle ───────────────────────────────────────────

type EndRequest  struct{ SessionID, ChannelID, UserAddress string }
type EndResult   struct{ FareUsdc, RefundUsdc string; SettledAt time.Time }

func (o *Orchestrator) EndSessionAndSettle(ctx context.Context, req EndRequest) (*EndResult, error) {
	sess, err := o.sessions.Get(req.SessionID)
	if err != nil {
		return nil, errors.Wrap(err, "getting session")
	}

	creditUsdc := o.refunds.GetTotal(req.ChannelID)

	// FinalUpdate (IsFinal=true)
	finalRes, err := o.channels.FinalUpdateAndAdjust(ctx, req.ChannelID, sess.ChargedUsdc, creditUsdc)
	if err != nil {
		return nil, errors.Wrap(err, "final update")
	}
	o.audit.Log(ctx, audit.ActionFinalUpdate, req.ChannelID, req.SessionID, finalRes)

	// Settle (perun-eth-backend Adjudicator.Withdraw)
	o.sessions.SetStatus(req.SessionID, session.StatusSettling) //nolint:errcheck
	closeRes, err := o.channels.CloseChannel(ctx, req.ChannelID)
	if err != nil {
		return nil, errors.Wrap(err, "closing channel")
	}
	o.sessions.End(req.SessionID)                                    //nolint:errcheck
	o.sessions.SetStatus(req.SessionID, session.StatusSettled)       //nolint:errcheck
	o.audit.Log(ctx, audit.ActionSettle, req.ChannelID, req.SessionID, closeRes)

	return &EndResult{
		FareUsdc:  closeRes.FinalFare,
		RefundUsdc: closeRes.FinalRefund,
		SettledAt: closeRes.SettledAt,
	}, nil
}

// 헬퍼
func max64(a, b int64) int64 { if a > b { return a }; return b }

func simpleHash(s string) []byte {
	h := make([]byte, 32)
	for i, c := range []byte(s) { h[i%32] ^= c }
	return h
}
