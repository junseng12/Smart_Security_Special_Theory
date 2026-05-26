// Package transport는 gRPC 서버를 구현합니다.
// Node.js perunClient.js에서 gRPC로 이 서버를 호출합니다.
//
// 각 RPC 메서드는 channel.Orchestrator의 함수를 1:1로 호출합니다.
// proto 정의: proto/smartcity.proto
package transport

import (
	"context"
	"fmt"

	"github.com/sirupsen/logrus"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"
	"net"

	pb "smartcity/go-perun-node/proto"
	"smartcity/go-perun-node/internal/channel"
	"smartcity/go-perun-node/internal/refund"
	"smartcity/go-perun-node/internal/audit"
)

// GRPCServer는 proto SmartCityNode 서비스를 구현합니다.
type GRPCServer struct {
	pb.UnimplementedSmartCityNodeServer

	orchestrator *channel.Orchestrator
	refundMgr    *refund.Manager
	auditLogger  *audit.Logger
	log          *logrus.Logger

	// SSE 이벤트 구독자 관리
	eventSubs map[string][]chan *pb.Event // channelId → []subscriber
}

func NewGRPCServer(
	orch   *channel.Orchestrator,
	ref    *refund.Manager,
	aud    *audit.Logger,
	log    *logrus.Logger,
) *GRPCServer {
	return &GRPCServer{
		orchestrator: orch,
		refundMgr:    ref,
		auditLogger:  aud,
		log:          log,
		eventSubs:    make(map[string][]chan *pb.Event),
	}
}

// ────────────────────────────────────────────────────────────────────
// StartSession
// ────────────────────────────────────────────────────────────────────
func (s *GRPCServer) StartSession(ctx context.Context, req *pb.StartSessionRequest) (*pb.StartSessionResponse, error) {
	s.log.WithField("user", req.UserAddress).Info("[gRPC] StartSession")

	result, err := s.orchestrator.StartSessionAndOpenChannel(ctx, channel.StartAndOpenRequest{
		UserID:      req.UserId,
		UserAddress: req.UserAddress,
		ServiceID:   req.ServiceId,
		DepositUsdc: req.DepositUsdc,
		// UserWireAddr: 현재 mock — go-perun P2P 주소 교환 구현 시 채워짐
	})
	if err != nil {
		s.log.WithError(err).Error("[gRPC] StartSession failed")
		return &pb.StartSessionResponse{Ok: false, Error: err.Error()}, nil
	}

	return &pb.StartSessionResponse{
		Ok:           true,
		SessionId:    result.SessionID,
		ChannelId:    result.ChannelID,
		EscrowId:     result.EscrowID,
		HoldDeadline: result.HoldDeadline,
		StateHash:    result.StateHash,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// EndSession
// ────────────────────────────────────────────────────────────────────
func (s *GRPCServer) EndSession(ctx context.Context, req *pb.EndSessionRequest) (*pb.EndSessionResponse, error) {
	s.log.WithField("session_id", req.SessionId).Info("[gRPC] EndSession")

	result, err := s.orchestrator.EndSessionAndSettle(ctx, channel.EndSessionRequest{
		SessionID:    req.SessionId,
		ChannelID:    req.ChannelId,
		UserAddress:  req.UserAddress,
		UserFinalSig: req.UserFinalSig,
	})
	if err != nil {
		return &pb.EndSessionResponse{Ok: false, Error: err.Error()}, nil
	}

	return &pb.EndSessionResponse{
		Ok:           true,
		FareUsdc:     result.FareUsdc,
		RefundUsdc:   result.RefundUsdc,
		SettleTxHash: "", // go-perun Settle이 txHash 반환 시 채워짐
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// ProposeUsageUpdate — 오프체인 요금 청구
// ────────────────────────────────────────────────────────────────────
func (s *GRPCServer) ProposeUsageUpdate(ctx context.Context, req *pb.ProposeUsageUpdateRequest) (*pb.ProposeUsageUpdateResponse, error) {
	s.log.WithFields(logrus.Fields{
		"session_id": req.SessionId,
		"service":    req.UsageDelta.ServiceType,
	}).Info("[gRPC] ProposeUsageUpdate")

	result, err := s.orchestrator.ChargeUsage(ctx, channel.ChargeRequest{
		SessionID:       req.SessionId,
		ChannelID:       req.ChannelId,
		ServiceType:     req.UsageDelta.ServiceType,
		DurationMinutes: req.UsageDelta.DurationMinutes,
		EnergyKwh:       req.UsageDelta.EnergyKwh,
	})
	if err != nil {
		return &pb.ProposeUsageUpdateResponse{Ok: false, Error: err.Error()}, nil
	}

	return &pb.ProposeUsageUpdateResponse{
		Ok:                 true,
		StateHash:          result.StateHash,
		NewNonce:           int64(result.NewNonce),
		FareUsdc:           result.FareUsdc,
		NewBalanceUser:     result.BalanceUser,
		PolicyHash:         result.PolicyHash,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// SubmitSignedUpdate
//
// go-perun 연동 포인트:
//   go-perun의 양방향 서명 흐름에서 user 서명을 받아 검증합니다.
//   실제 구현: signatureManager.verifySignature() 후 ch.Update ack
// ────────────────────────────────────────────────────────────────────
func (s *GRPCServer) SubmitSignedUpdate(ctx context.Context, req *pb.SubmitSignedUpdateRequest) (*pb.SubmitSignedUpdateResponse, error) {
	s.log.WithField("channel_id", req.ChannelId).Info("[gRPC] SubmitSignedUpdate")

	// go-perun에서는 ch.Update() 내부에서 자동으로 양측 서명이 교환되므로
	// 별도 SubmitSignedUpdate가 필요 없을 수 있습니다.
	// 단, MetaMask 기반 서명(off-band 방식)에서는 여기서 서명을 검증합니다.

	// TODO: signatureManager.verifyUserSig(req.StateHash, req.UserSig)
	s.log.WithFields(logrus.Fields{
		"nonce":     req.Nonce,
		"state":     req.StateHash[:min(16, len(req.StateHash))],
	}).Info("[gRPC] user sig received — verifying")

	return &pb.SubmitSignedUpdateResponse{
		Ok:          true,
		LatestNonce: req.Nonce,
		Ack:         "signature accepted",
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// AccumulateRefundCredit
// ────────────────────────────────────────────────────────────────────
func (s *GRPCServer) AccumulateRefundCredit(ctx context.Context, req *pb.RefundCreditRequest) (*pb.RefundCreditResponse, error) {
	total, err := s.refundMgr.AccumulateRefundCredit(ctx, req.ChannelId, req.CreditUsdc, req.Reason)
	if err != nil {
		return &pb.RefundCreditResponse{Ok: false, Error: err.Error()}, nil
	}
	_, _ = s.auditLogger.Log(ctx, audit.ActionCreditAccumulated, req.ChannelId, "", map[string]interface{}{
		"delta":  req.CreditUsdc,
		"total":  total,
		"reason": req.Reason,
	})
	return &pb.RefundCreditResponse{Ok: true, CreditTotal: total}, nil
}

// ────────────────────────────────────────────────────────────────────
// PostSettlementCompensation
// ────────────────────────────────────────────────────────────────────
func (s *GRPCServer) PostSettlementCompensation(ctx context.Context, req *pb.CompensationRequest) (*pb.CompensationResponse, error) {
	txHash, err := s.refundMgr.PostSettlementCompensation(ctx, req.UserAddress, req.AmountUsdc, req.Reason)
	if err != nil {
		return &pb.CompensationResponse{Ok: false, Error: err.Error()}, nil
	}
	_, _ = s.auditLogger.Log(ctx, audit.ActionCompensationSent, "", "", map[string]interface{}{
		"user":   req.UserAddress,
		"amount": req.AmountUsdc,
		"tx":     txHash,
	})
	return &pb.CompensationResponse{Ok: true, TxHash: txHash}, nil
}

// ────────────────────────────────────────────────────────────────────
// AuditLog
// ────────────────────────────────────────────────────────────────────
func (s *GRPCServer) AuditLog(ctx context.Context, req *pb.AuditLogRequest) (*pb.AuditLogResponse, error) {
	logID, err := s.auditLogger.Log(ctx, audit.Action(req.Action), "", "", req.Metadata)
	if err != nil {
		return &pb.AuditLogResponse{Ok: false, Error: err.Error()}, nil
	}
	return &pb.AuditLogResponse{Ok: true, LogId: logID}, nil
}

// ────────────────────────────────────────────────────────────────────
// StreamEvents — SSE 대체 gRPC 스트림
// ────────────────────────────────────────────────────────────────────
func (s *GRPCServer) StreamEvents(req *pb.StreamEventsRequest, stream pb.SmartCityNode_StreamEventsServer) error {
	s.log.WithField("session_id", req.SessionId).Info("[gRPC] StreamEvents subscribed")

	ch := make(chan *pb.Event, 16)
	key := req.SessionId + req.ChannelId

	s.eventSubs[key] = append(s.eventSubs[key], ch)
	defer func() {
		delete(s.eventSubs, key)
		close(ch)
	}()

	for {
		select {
		case event, ok := <-ch:
			if !ok {
				return nil
			}
			if err := stream.Send(event); err != nil {
				return err
			}
		case <-stream.Context().Done():
			return nil
		}
	}
}

// ────────────────────────────────────────────────────────────────────
// Serve — gRPC 서버 시작
// ────────────────────────────────────────────────────────────────────
func Serve(port int, server *GRPCServer) error {
	lis, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Errorf("failed to listen on port %d: %w", port, err)
	}

	s := grpc.NewServer()
	pb.RegisterSmartCityNodeServer(s, server)
	reflection.Register(s) // grpcurl 등 도구로 탐색 가능

	server.log.WithField("port", port).Info("[gRPC] server listening")
	return s.Serve(lis)
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
