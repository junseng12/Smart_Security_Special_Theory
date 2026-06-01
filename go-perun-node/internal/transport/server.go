package transport

import (
	"context"
	"fmt"
	"net"
	"time"

	"github.com/sirupsen/logrus"
	"google.golang.org/grpc"
	"google.golang.org/grpc/reflection"

	pb "smartcity/go-perun-node/proto"
	"smartcity/go-perun-node/internal/audit"
	"smartcity/go-perun-node/internal/channel"
	"smartcity/go-perun-node/internal/refund"
)

type Server struct {
	pb.UnimplementedSmartCityNodeServer
	orch    *channel.Orchestrator
	refunds *refund.Manager
	aud     *audit.Logger
	log     *logrus.Logger
}

func New(orch *channel.Orchestrator, ref *refund.Manager, aud *audit.Logger, log *logrus.Logger) *Server {
	return &Server{orch: orch, refunds: ref, aud: aud, log: log}
}

// StartSession — gRPC deadline에서 독립된 context 사용 (온체인 펀딩은 오래 걸림)
func (s *Server) StartSession(ctx context.Context, req *pb.StartSessionRequest) (*pb.StartSessionResponse, error) {
	// ★ 온체인 tx 포함 작업이므로 gRPC deadline과 분리된 독립 context 사용
	// gRPC ctx가 취소돼도 펀딩은 계속 진행
	fundCtx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	s.log.WithFields(logrus.Fields{
		"user":    req.UserAddress,
		"service": req.ServiceId,
		"deposit": req.DepositUsdc,
	}).Info("[Session] StartSession (fundCtx 3min)")

	res, err := s.orch.StartSessionAndOpen(fundCtx, channel.StartRequest{
		UserAddress: req.UserAddress,
		ServiceID:   req.ServiceId,
		DepositUsdc: req.DepositUsdc,
		HoldSeconds: req.HoldSeconds,
	})
	if err != nil {
		s.log.WithError(err).Error("[Session] StartSession failed")
		return &pb.StartSessionResponse{Ok: false, Error: err.Error()}, nil
	}
	s.log.WithField("session_id", res.SessionID).Info("[Session] ✅ StartSession success")
	return &pb.StartSessionResponse{
		Ok:           true,
		SessionId:    res.SessionID,
		ChannelId:    res.ChannelID,
		EscrowId:     res.EscrowID,
		HoldDeadline: res.HoldDeadline,
		StateHash:    res.StateHash,
	}, nil
}

// EndSession — 온체인 정산도 시간이 걸림
func (s *Server) EndSession(ctx context.Context, req *pb.EndSessionRequest) (*pb.EndSessionResponse, error) {
	settleCtx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	res, err := s.orch.EndSessionAndSettle(settleCtx, channel.EndRequest{
		SessionID:   req.SessionId,
		ChannelID:   req.ChannelId,
		UserAddress: req.UserAddress,
	})
	if err != nil {
		return &pb.EndSessionResponse{Ok: false, Error: err.Error()}, nil
	}
	return &pb.EndSessionResponse{Ok: true, FareUsdc: res.FareUsdc, RefundUsdc: res.RefundUsdc}, nil
}

func (s *Server) ProposeUsageUpdate(ctx context.Context, req *pb.ProposeUsageUpdateRequest) (*pb.ProposeUsageUpdateResponse, error) {
	res, err := s.orch.ChargeUsage(ctx, channel.ChargeReq{
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
		Ok:          true,
		FareUsdc:    res.FareUsdc,
		PolicyHash:  res.PolicyHash,
		NewNonce:    int64(res.NewNonce),
		StateHash:   res.StateHash,
		BalanceUser: res.BalanceUser,
	}, nil
}

func (s *Server) GetChannelStatus(ctx context.Context, req *pb.GetChannelStatusRequest) (*pb.ChannelStatusResponse, error) {
	status, err := s.orch.GetStatus(ctx, req.ChannelId)
	if err != nil {
		return &pb.ChannelStatusResponse{Ok: false, Error: err.Error()}, nil
	}
	return &pb.ChannelStatusResponse{
		Ok:          true,
		Nonce:       int64(status.Nonce),
		BalanceUser: fmt.Sprintf("%f", status.BalanceUser),
		BalanceOp:   fmt.Sprintf("%f", status.BalanceOp),
	}, nil
}

func (s *Server) InitiateDispute(ctx context.Context, req *pb.InitiateDisputeRequest) (*pb.InitiateDisputeResponse, error) {
	s.log.WithField("channel_id", req.ChannelId).Warn("[Dispute] InitiateDispute requested")
	err := s.orch.RegisterDispute(ctx, req.ChannelId)
	if err != nil {
		return &pb.InitiateDisputeResponse{Ok: false, Error: err.Error()}, nil
	}
	return &pb.InitiateDisputeResponse{Ok: true}, nil
}

func (s *Server) PostCompensation(ctx context.Context, req *pb.PostCompensationRequest) (*pb.PostCompensationResponse, error) {
	err := s.refunds.PostCompensation(req.UserAddress, req.AmountUsdc, req.Reason)
	if err != nil {
		return &pb.PostCompensationResponse{Ok: false, Error: err.Error()}, nil
	}
	return &pb.PostCompensationResponse{Ok: true}, nil
}

func (s *Server) AccumulateCredit(ctx context.Context, req *pb.AccumulateCreditRequest) (*pb.AccumulateCreditResponse, error) {
	total, err := s.refunds.Accumulate(req.ChannelId, req.CreditUsdc, req.Reason)
	if err != nil {
		return &pb.AccumulateCreditResponse{Ok: false, Error: err.Error()}, nil
	}
	s.aud.Log(ctx, audit.ActionCreditAccum, req.ChannelId, "", map[string]any{"total": total})
	return &pb.AccumulateCreditResponse{Ok: true, Total: total}, nil
}

func (s *Server) AuditLog(ctx context.Context, req *pb.AuditLogRequest) (*pb.AuditLogResponse, error) {
	id := s.aud.Log(ctx, audit.Action(req.Action), "", "", req.Metadata)
	return &pb.AuditLogResponse{Ok: true, LogId: id}, nil
}

func (s *Server) StreamEvents(req *pb.StreamEventsRequest, stream pb.SmartCityNode_StreamEventsServer) error {
	<-stream.Context().Done()
	return nil
}

func Serve(port int, srv *Server) error {
	lis, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		return fmt.Errorf("listen :%d: %w", port, err)
	}
	// ★ gRPC 서버 keepalive + 최대 수신 크기 설정
	g := grpc.NewServer(
		grpc.MaxRecvMsgSize(16*1024*1024),
	)
	pb.RegisterSmartCityNodeServer(g, srv)
	reflection.Register(g)
	srv.log.WithField("port", port).Info("[gRPC] server listening")
	return g.Serve(lis)
}
