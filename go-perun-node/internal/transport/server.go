package transport

import (
	"context"
	"fmt"
	"net"

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

func (s *Server) StartSession(ctx context.Context, req *pb.StartSessionRequest) (*pb.StartSessionResponse, error) {
	res, err := s.orch.StartSessionAndOpen(ctx, channel.StartRequest{
		UserAddress: req.UserAddress,
		ServiceID:   req.ServiceId,
		DepositUsdc: req.DepositUsdc,
		HoldSeconds: req.HoldSeconds,
	})
	if err != nil {
		return &pb.StartSessionResponse{Ok: false, Error: err.Error()}, nil
	}
	return &pb.StartSessionResponse{
		Ok: true, SessionId: res.SessionID, ChannelId: res.ChannelID,
		EscrowId: res.EscrowID, HoldDeadline: res.HoldDeadline, StateHash: res.StateHash,
	}, nil
}

func (s *Server) EndSession(ctx context.Context, req *pb.EndSessionRequest) (*pb.EndSessionResponse, error) {
	res, err := s.orch.EndSessionAndSettle(ctx, channel.EndRequest{
		SessionID: req.SessionId, ChannelID: req.ChannelId, UserAddress: req.UserAddress,
	})
	if err != nil {
		return &pb.EndSessionResponse{Ok: false, Error: err.Error()}, nil
	}
	return &pb.EndSessionResponse{Ok: true, FareUsdc: res.FareUsdc, RefundUsdc: res.RefundUsdc}, nil
}

func (s *Server) ProposeUsageUpdate(ctx context.Context, req *pb.ProposeUsageUpdateRequest) (*pb.ProposeUsageUpdateResponse, error) {
	res, err := s.orch.ChargeUsage(ctx, channel.ChargeReq{
		SessionID: req.SessionId, ChannelID: req.ChannelId,
		ServiceType: req.UsageDelta.ServiceType,
		DurationMinutes: req.UsageDelta.DurationMinutes,
		EnergyKwh: req.UsageDelta.EnergyKwh,
	})
	if err != nil {
		return &pb.ProposeUsageUpdateResponse{Ok: false, Error: err.Error()}, nil
	}
	return &pb.ProposeUsageUpdateResponse{
		Ok: true, FareUsdc: res.FareUsdc, PolicyHash: res.PolicyHash,
		NewNonce: int64(res.NewNonce), StateHash: res.StateHash, BalanceUser: res.BalanceUser,
	}, nil
}

func (s *Server) InitiateDispute(ctx context.Context, req *pb.InitiateDisputeRequest) (*pb.InitiateDisputeResponse, error) {
	if err := s.orch.(*channel.Orchestrator); err != nil { // type check only
	}
	// 직접 channel manager 접근 필요 — orchestrator에 노출 예정
	return &pb.InitiateDisputeResponse{Ok: true}, nil
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
	g := grpc.NewServer()
	pb.RegisterSmartCityNodeServer(g, srv)
	reflection.Register(g)
	srv.log.WithField("port", port).Info("[gRPC] server listening")
	return g.Serve(lis)
}
