// orchestrator.go — SmartCity 비즈니스 로직 포장지
//
// Node.js의 channelOrchestrator.js를 Go로 이식한 계층입니다.
// session, channel, pricing, refund, audit 모듈을 조율합니다.
//
// gRPC 서버(server.go)는 이 Orchestrator의 함수를 직접 호출합니다.
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

// ────────────────────────────────────────────────────────────────────
// Orchestrator — 비즈니스 흐름 조율자
// ────────────────────────────────────────────────────────────────────

type Orchestrator struct {
	sessions *session.Manager
	channels *Manager       // go-perun 채널 관리자
	refunds  *refund.Manager
	audit    *audit.Logger
	log      *logrus.Logger
}

func NewOrchestrator(
	sessions *session.Manager,
	channels *Manager,
	refunds  *refund.Manager,
	auditLog *audit.Logger,
	log      *logrus.Logger,
) *Orchestrator {
	return &Orchestrator{
		sessions: sessions,
		channels: channels,
		refunds:  refunds,
		audit:    auditLog,
		log:      log,
	}
}

// ────────────────────────────────────────────────────────────────────
// StartSessionAndOpenChannel
//
// 대응: Node.js channelOrchestrator.startSessionAndOpenChannel()
//
// 흐름:
//   1) session.StartSession()     — 세션 DB 생성
//   2) channel.OpenChannel()      — go-perun ProposeChannel() + Funder.Fund()
//   3) session.LinkChannel()      — 세션 ↔ 채널 연결
//   4) audit.Log(CHANNEL_OPEN)
// ────────────────────────────────────────────────────────────────────
func (o *Orchestrator) StartSessionAndOpenChannel(ctx context.Context, req StartAndOpenRequest) (*StartAndOpenResult, error) {
	o.log.WithFields(logrus.Fields{
		"user":    req.UserAddress,
		"service": req.ServiceID,
		"deposit": req.DepositUsdc,
	}).Info("[Orchestrator] StartSessionAndOpenChannel")

	// 1. 세션 생성
	sess, err := o.sessions.StartSession(ctx, session.StartParams{
		UserID:      req.UserID,
		UserAddress: req.UserAddress,
		ServiceID:   req.ServiceID,
		DepositUsdc: req.DepositUsdc,
	})
	if err != nil {
		return nil, errors.Wrap(err, "starting session")
	}

	// 2. holdDeadline 계산 (기본 2분)
	holdSeconds := int64(120)
	if req.HoldSeconds > 0 {
		holdSeconds = req.HoldSeconds
	}
	holdDeadline := time.Now().Unix() + holdSeconds

	// 3. Perun 채널 개설
	handle, err := o.channels.OpenChannel(ctx, OpenChannelParams{
		SessionID:    sess.ID,
		UserAddress:  req.UserAddress,
		UserWireAddr: req.UserWireAddr,
		DepositUsdc:  req.DepositUsdc,
		HoldDeadline: holdDeadline,
	})
	if err != nil {
		// 채널 개설 실패 시 세션 정리
		_ = o.sessions.EndSession(ctx, sess.ID)
		return nil, errors.Wrap(err, "opening channel")
	}

	// 4. 세션 ↔ 채널 연결
	// EscrowID = keccak256(sessionId) — 컨트랙트 호환
	escrowID := fmt.Sprintf("0x%x", hashSessionID(sess.ID))
	if err := o.sessions.LinkChannel(ctx, sess.ID, handle.ChannelID, escrowID, holdDeadline); err != nil {
		return nil, errors.Wrap(err, "linking channel to session")
	}

	// 5. 감사 로그
	_, _ = o.audit.Log(ctx, audit.ActionChannelOpen, handle.ChannelID, sess.ID, map[string]interface{}{
		"deposit_usdc":  req.DepositUsdc,
		"hold_deadline": holdDeadline,
		"escrow_id":     escrowID,
	})

	o.audit.EmitEvent("SESSION_STARTED", handle.ChannelID, sess.ID, map[string]interface{}{
		"session_id": sess.ID,
		"service_id": req.ServiceID,
	})

	return &StartAndOpenResult{
		SessionID:    sess.ID,
		ChannelID:    handle.ChannelID,
		EscrowID:     escrowID,
		HoldDeadline: holdDeadline,
		StateHash:    handle.latestStateHash,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// ChargeUsage — 오프체인 요금 청구
//
// 대응: Node.js channelOrchestrator.chargeUsage()
//
// 흐름:
//   1) channel.ProposeUsageUpdate()  — go-perun ch.Update() 호출
//      → state.Allocation.TransferBalance(user→operator, fareWei)
//      → 양측 서명 교환 (P2P)
//   2) session.AccumulateCharge()    — charged_usdc 누적
//   3) audit.Log(USAGE_CHARGE)
// ────────────────────────────────────────────────────────────────────
func (o *Orchestrator) ChargeUsage(ctx context.Context, req ChargeRequest) (*ChargeResult, error) {
	// 1. go-perun 오프체인 업데이트
	updateResult, err := o.channels.ProposeUsageUpdate(ctx, UpdateRequest{
		ChannelID:       req.ChannelID,
		ServiceType:     req.ServiceType,
		DurationMinutes: req.DurationMinutes,
		EnergyKwh:       req.EnergyKwh,
	})
	if err != nil {
		return nil, errors.Wrap(err, "proposing usage update")
	}

	// 2. 세션 charged_usdc 누적
	if err := o.sessions.AccumulateCharge(ctx, req.SessionID, updateResult.FareUsdc); err != nil {
		o.log.WithError(err).Warn("[Orchestrator] failed to accumulate charge in session")
	}

	// 3. 감사 로그
	_, _ = o.audit.Log(ctx, audit.ActionUsageCharge, req.ChannelID, req.SessionID, map[string]interface{}{
		"fare_usdc":    updateResult.FareUsdc,
		"nonce":        updateResult.NewNonce,
		"policy_hash":  updateResult.PolicyHash,
		"duration_min": req.DurationMinutes,
	})

	o.audit.EmitEvent("STATE_UPDATED", req.ChannelID, req.SessionID, map[string]interface{}{
		"fare_usdc":   updateResult.FareUsdc,
		"nonce":       updateResult.NewNonce,
		"balance_user": updateResult.BalanceUser,
	})

	return &ChargeResult{
		FareUsdc:    updateResult.FareUsdc,
		NewNonce:    updateResult.NewNonce,
		StateHash:   updateResult.StateHash,
		PolicyHash:  updateResult.PolicyHash,
		BalanceUser: updateResult.BalanceUser,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// EndSessionAndSettle — 세션 종료 + 정산
//
// 대응: Node.js channelOrchestrator.endSessionAndSettle()
//
// 흐름:
//   1) refund.GetTotalCredit()       — 누적 credit 조회
//   2) channel.FinalUpdateAndAdjust() — go-perun ch.Update(IsFinal=true)
//      → credit 차감 반영 + IsFinal=true 플래그
//   3) channel.CloseChannel()        — go-perun ch.Settle()
//      → Adjudicator.Withdraw() → USDC 각자 지갑으로 출금
//   4) session.EndSession() + MarkSettled()
//   5) audit.Log(CHANNEL_SETTLE)
// ────────────────────────────────────────────────────────────────────
func (o *Orchestrator) EndSessionAndSettle(ctx context.Context, req EndSessionRequest) (*EndSessionResult, error) {
	o.log.WithFields(logrus.Fields{
		"session_id": req.SessionID,
		"channel_id": req.ChannelID,
	}).Info("[Orchestrator] EndSessionAndSettle")

	// 1. 누적 credit 조회
	creditUsdc := o.refunds.GetTotalCredit(req.ChannelID)

	// 2. 세션의 총 charged_usdc 조회
	sess, err := o.sessions.Get(req.SessionID)
	if err != nil {
		return nil, errors.Wrap(err, "getting session")
	}

	// 3. 최종 업데이트 (credit 반영 + IsFinal=true)
	finalResult, err := o.channels.FinalUpdateAndAdjust(ctx, req.ChannelID, creditUsdc, sess.ChargedUsdc)
	if err != nil {
		return nil, errors.Wrap(err, "final update and adjust")
	}

	_, _ = o.audit.Log(ctx, audit.ActionFinalUpdate, req.ChannelID, req.SessionID, map[string]interface{}{
		"total_fare":  finalResult.TotalFareUsdc,
		"credit_usdc": creditUsdc,
		"final_nonce": finalResult.FinalNonce,
	})

	// 4. go-perun ch.Settle() 호출
	if err := o.sessions.MarkSettling(ctx, req.SessionID); err != nil {
		o.log.WithError(err).Warn("failed to mark settling")
	}

	closeResult, err := o.channels.CloseChannel(ctx, req.ChannelID)
	if err != nil {
		return nil, errors.Wrap(err, "closing channel")
	}

	// 5. 세션 정리
	_ = o.sessions.EndSession(ctx, req.SessionID)
	_ = o.sessions.MarkSettled(ctx, req.SessionID)

	// 6. 감사 로그
	_, _ = o.audit.Log(ctx, audit.ActionChannelSettle, req.ChannelID, req.SessionID, map[string]interface{}{
		"fare_usdc":     finalResult.TotalFareUsdc,
		"refund_usdc":   finalResult.FinalBalanceUser,
		"settled_at":    closeResult.SettledAt,
	})

	o.audit.EmitEvent("SETTLED", req.ChannelID, req.SessionID, map[string]interface{}{
		"fare_usdc":   finalResult.TotalFareUsdc,
		"refund_usdc": finalResult.FinalBalanceUser,
	})

	return &EndSessionResult{
		FareUsdc:   finalResult.TotalFareUsdc,
		RefundUsdc: finalResult.FinalBalanceUser,
		SettledAt:  closeResult.SettledAt,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────

type StartAndOpenRequest struct {
	UserID       string
	UserAddress  string
	UserWireAddr interface{} // wallet.BackendID → wire.Address
	ServiceID    string
	DepositUsdc  string
	HoldSeconds  int64
}

type StartAndOpenResult struct {
	SessionID    string
	ChannelID    string
	EscrowID     string
	HoldDeadline int64
	StateHash    string
}

type ChargeRequest struct {
	SessionID       string
	ChannelID       string
	ServiceType     string
	DurationMinutes float64
	EnergyKwh       float64
}

type ChargeResult struct {
	FareUsdc    string
	NewNonce    uint64
	StateHash   string
	PolicyHash  string
	BalanceUser string
}

type EndSessionRequest struct {
	SessionID    string
	ChannelID    string
	UserAddress  string
	UserFinalSig string
}

type EndSessionResult struct {
	FareUsdc   string
	RefundUsdc string
	SettledAt  time.Time
}

// hashSessionID — keccak256(sessionId) 간소화 버전
func hashSessionID(sessionID string) []byte {
	// Production에서는 go-ethereum의 crypto.Keccak256 사용
	// import "github.com/ethereum/go-ethereum/crypto"
	// return crypto.Keccak256([]byte(sessionID))
	h := make([]byte, 32)
	for i, b := range []byte(sessionID) {
		h[i%32] ^= b
	}
	return h
}
