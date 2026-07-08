// orchestrator.go — SmartCity 비즈니스 로직 포장지
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

type StartRequest struct {
	UserAddress  string
	ServiceID    string
	DepositUsdc  string
	UserWireAddr interface{}
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
	sess, err := o.sessions.Start(ctx, req.UserAddress, req.ServiceID, req.DepositUsdc)
	if err != nil {
		return nil, errors.Wrap(err, "starting session")
	}

	holdDeadline := time.Now().Unix() + max64(req.HoldSeconds, 120)

	openRes, err := o.channels.OpenChannel(ctx, OpenParams{
		SessionID:    sess.ID,
		UserAddress:  req.UserAddress,
		DepositUsdc:  req.DepositUsdc,
		HoldDeadline: holdDeadline,
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

// EndRequest — ChargedUsdc 필드 추가
// ★ 컨테이너 재시작 시 인메모리 세션 유실 대비
//   Node.js 백엔드가 DB에서 읽은 charged_usdc를 user_final_sig 필드에 실어 전달하고
//   transport/server.go에서 이를 ChargedUsdc로 매핑해 사용
type EndRequest struct {
	SessionID   string
	ChannelID   string
	UserAddress string
	ChargedUsdc string // DB 폴백 값 (인메모리 미스 시 사용)
}
type EndResult struct{ FareUsdc, RefundUsdc string; SettledAt time.Time }

func (o *Orchestrator) EndSessionAndSettle(ctx context.Context, req EndRequest) (*EndResult, error) {
	// ★ 인메모리 세션에서 chargedUsdc 읽기 — 없으면 요청에서 전달된 값 사용
	chargedUsdc := req.ChargedUsdc
	sess, sessErr := o.sessions.Get(req.SessionID)
	if sessErr == nil {
		chargedUsdc = sess.ChargedUsdc
		o.log.WithField("session_id", req.SessionID).Info("[Orchestrator] session found in-memory")
	} else {
		o.log.WithFields(logrus.Fields{
			"session_id":   req.SessionID,
			"charged_usdc": chargedUsdc,
		}).Warn("[Orchestrator] session not in-memory, using provided chargedUsdc as fallback")
		if chargedUsdc == "" {
			chargedUsdc = "0"
		}
	}

	creditUsdc := o.refunds.GetTotal(req.ChannelID)

	finalRes, err := o.channels.FinalUpdateAndAdjust(ctx, req.ChannelID, chargedUsdc, creditUsdc)
	if err != nil {
		return nil, errors.Wrap(err, "final update")
	}
	o.audit.Log(ctx, audit.ActionFinalUpdate, req.ChannelID, req.SessionID, finalRes)

	o.sessions.SetStatus(req.SessionID, session.StatusSettling) //nolint:errcheck
	closeRes, err := o.channels.CloseChannel(ctx, req.ChannelID)
	if err != nil {
		return nil, errors.Wrap(err, "closing channel")
	}
	o.sessions.End(req.SessionID)                              //nolint:errcheck
	o.sessions.SetStatus(req.SessionID, session.StatusSettled) //nolint:errcheck
	o.audit.Log(ctx, audit.ActionSettle, req.ChannelID, req.SessionID, closeRes)

	return &EndResult{
		FareUsdc:   closeRes.FinalFare,
		RefundUsdc: closeRes.FinalRefund,
		SettledAt:  closeRes.SettledAt,
	}, nil
}

func max64(a, b int64) int64 { if a > b { return a }; return b }

func simpleHash(s string) []byte {
	h := make([]byte, 32)
	for i, c := range []byte(s) { h[i%32] ^= c }
	return h
}

type StatusResult struct {
	State       string
	BalanceUser float64
	BalanceOp   float64
	Nonce       uint64
}

func (o *Orchestrator) GetStatus(_ context.Context, channelID string) (*StatusResult, error) {
	h, err := o.channels.GetStatus(channelID)
	if err != nil {
		return nil, fmt.Errorf("channel not found: %w", err)
	}
	return &StatusResult{State: "open", BalanceUser: 0, BalanceOp: 0, Nonce: h.latestNonce}, nil
}

func (o *Orchestrator) RegisterDispute(ctx context.Context, channelID string) error {
	o.log.WithField("channel_id", channelID).Warn("[Dispute] registering on-chain dispute")
	return o.channels.InitiateDispute(ctx, channelID)
}
