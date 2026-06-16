// Package channel은 perun-eth-backend 기반의 실제 채널 생명주기를 관리합니다.
//
// ★ Custodial 모드: 사용자 키쌍을 서버 내부에서 생성하여 P2P 피어 없이 동작
//   OpenChannel  → 내부 UserNode 생성 → ProposeChannel + 자동 수락
//   ChargeUsage  → ch.Update(TransferBalance) [오프체인 — 서명만, TX 없음]
//   FinalUpdate  → ch.Update(IsFinal=true)    [credit 차감 + 채널 최종화]
//   CloseChannel → ch.Settle()               [perun-eth-backend Adjudicator가 Withdraw]
//   Dispute      → ch.ForceUpdate()           [수동 분쟁 트리거]
package channel

import (
	"context"
	"fmt"
	"math/big"
	"sync"
	"time"

	// ── perun-eth-backend ─────────────────────────────────────────────
	ethwallet "github.com/perun-network/perun-eth-backend/wallet"

	// ── go-perun SDK ──────────────────────────────────────────────────
	"perun.network/go-perun/channel"
	"perun.network/go-perun/client"
	"perun.network/go-perun/wallet"
	"perun.network/go-perun/wire"

	"github.com/pkg/errors"
	"github.com/sirupsen/logrus"

	"smartcity/go-perun-node/internal/pricing"
	"smartcity/go-perun-node/internal/setup"
)

// ────────────────────────────────────────────────────────────────────
// Manager
// ────────────────────────────────────────────────────────────────────

type Manager struct {
	mu       sync.RWMutex
	channels map[string]*Handle // channelID → handle

	node    *setup.PerunNode // setup 패키지에서 초기화된 노드
	cfg     *setup.Config    // ★ custodial UserNode 생성용
	pricing *pricing.Engine
	log     *logrus.Logger
}

func NewManager(node *setup.PerunNode, cfg *setup.Config, log *logrus.Logger) *Manager {
	return &Manager{
		channels: make(map[string]*Handle),
		node:     node,
		cfg:      cfg,
		pricing:  pricing.NewEngine(),
		log:      log,
	}
}

// Handle — 단일 채널 래퍼
type Handle struct {
	mu sync.Mutex

	ChannelID    string
	SessionID    string
	UserAddress  string // MetaMask 주소 (표시용)
	UserEthAddr  string // custodial 생성 주소
	DepositUsdc  string
	HoldDeadline int64

	// ★ go-perun 실제 채널 객체
	ch       *client.Channel
	userNode *setup.UserNode // custodial 사용자 노드 (메모리 보관)

	// 상태 캐시
	latestNonce     uint64
	latestStateHash string
	balanceUser     *big.Int
	balanceOp       *big.Int
}

// ────────────────────────────────────────────────────────────────────
// OpenChannel — Custodial 방식
//
// 기존: 외부 P2P 피어(UserWireAddr) 필요
// 변경: 서버 내부에서 UserNode 생성 → 자동 수락
//
// 흐름:
//   1. setup.NewUserNode() → 사용자 키쌍 + go-perun 클라이언트 생성
//   2. userNode.Client.Handle(autoAcceptHandler) → 고루틴으로 수락 대기
//   3. m.node.Client.ProposeChannel() → 내부 P2P로 userNode에 제안
//   4. userNode가 자동 수락 → 채널 개설
//   5. Funder.Fund() → USDC approve+deposit TX (운영자 측만, 사용자 예치는 0)
// ────────────────────────────────────────────────────────────────────

type OpenParams struct {
	SessionID    string
	UserAddress  string // MetaMask 주소 (참조/표시용)
	DepositUsdc  string // 예치금 (운영자가 대신 예치)
	HoldDeadline int64
}

type OpenResult struct {
	ChannelID      string
	StateHash      string
	InitNonce      uint64
	UserCustodialAddr string // custodial 생성된 사용자 주소
}

func (m *Manager) OpenChannel(ctx context.Context, p OpenParams) (*OpenResult, error) {
	m.log.WithFields(logrus.Fields{
		"session": p.SessionID,
		"user":    p.UserAddress,
		"deposit": p.DepositUsdc,
	}).Info("[Channel] OpenChannel (custodial)")

	depositWei := usdcToWei(p.DepositUsdc)

	// ── Step 1: 사용자 custodial 노드 생성 ────────────────────────────
	userNode, err := setup.NewUserNode(m.cfg, m.node.Bus)
	if err != nil {
		return nil, fmt.Errorf("creating custodial user node: %w", err)
	}
	m.log.WithField("user_custodial", userNode.Address.Hex()).Info("[Channel] custodial user node created")

	// ── Step 2: 사용자 노드 핸들러 시작 (자동 수락) ───────────────────
	go userNode.Client.Handle(
		&autoAcceptProposalHandler{log: m.log, participant: userNode.EthAddress},
		&autoAcceptUpdateHandler{log: m.log},
	)

	// ── Step 3: 초기 자금 배분 ────────────────────────────────────────
	// participants[0] = operator (idx=0) : 예치 depositWei (대신 예치)
	// participants[1] = user     (idx=1) : 예치 0
	initAlloc := channel.NewAllocation(
		2,
		[]wallet.BackendID{ethwallet.BackendID},
		m.node.USDCAsset,
	)
	// ★ SmartCityEscrow가 자금 보관/정산 전담 → AssetHolder 예치 불필요
	// Perun 채널은 오프체인 요금 계산 및 서명 추적 역할만 수행
	initAlloc.SetAssetBalances(m.node.USDCAsset, []channel.Bal{
		big.NewInt(0), // operator: SmartCityEscrow에 예치 (AssetHolder 이중 예치 제거)
		big.NewInt(0), // user:     SmartCityEscrow에 예치 (MetaMask 직접)
	})

	// ── Step 4: 채널 제안 ─────────────────────────────────────────────
	challengeDuration := uint64(120)
	peers := []map[wallet.BackendID]wire.Address{
		m.node.WireAddress,      // operator (proposer, idx=0)
		userNode.WireAddress,    // user custodial (idx=1)
	}

	proposal, err := client.NewLedgerChannelProposal(
		challengeDuration,
		m.node.EthAddress,
		initAlloc,
		peers,
	)
	if err != nil {
		return nil, errors.Wrap(err, "creating channel proposal")
	}

	// ── Step 5: ProposeChannel ────────────────────────────────────────
	// autoAcceptProposalHandler가 userNode 측에서 자동 수락
	ch, err := m.node.Client.ProposeChannel(ctx, proposal)
	if err != nil {
		return nil, errors.Wrap(err, "ProposeChannel (custodial)")
	}

	// ── Step 6: Dispute Watcher ───────────────────────────────────────
	go func() {
		if err := ch.Watch(&adjEventHandler{log: m.log, channelID: ch.ID()}); err != nil {
			m.log.WithError(err).Warn("[Channel] watcher exited")
		}
	}()

	// ── Step 7: 핸들 등록 ─────────────────────────────────────────────
	state := ch.State()
	h := &Handle{
		ChannelID:       fmt.Sprintf("0x%x", ch.ID()),
		SessionID:       p.SessionID,
		UserAddress:     p.UserAddress,
		UserEthAddr:     userNode.Address.Hex(),
		DepositUsdc:     p.DepositUsdc,
		HoldDeadline:    p.HoldDeadline,
		ch:              ch,
		userNode:        userNode,
		latestNonce:     uint64(state.Version),
		latestStateHash: stateDigest(state),
		balanceUser:     new(big.Int).Set(depositWei),
		balanceOp:       big.NewInt(0),
	}

	m.mu.Lock()
	m.channels[h.ChannelID] = h
	m.mu.Unlock()

	m.log.WithFields(logrus.Fields{
		"channel_id":    h.ChannelID,
		"user_custodial": userNode.Address.Hex(),
	}).Info("[Channel] ✅ opened (custodial)")

	return &OpenResult{
		ChannelID:         h.ChannelID,
		StateHash:         h.latestStateHash,
		InitNonce:         h.latestNonce,
		UserCustodialAddr: userNode.Address.Hex(),
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// ChargeUsage — 오프체인 요금 청구 (변경 없음)
// ────────────────────────────────────────────────────────────────────

type ChargeRequest struct {
	ChannelID       string
	ServiceType     string
	DurationMinutes float64
	EnergyKwh       float64
}

type ChargeResult struct {
	FareUsdc    string
	PolicyHash  string
	NewNonce    uint64
	StateHash   string
	BalanceUser string
	BalanceOp   string
}

func (m *Manager) ChargeUsage(ctx context.Context, req ChargeRequest) (*ChargeResult, error) {
	h, err := m.get(req.ChannelID)
	if err != nil {
		return nil, err
	}

	fare, err := m.pricing.CalculateFare(pricing.UsageDelta{
		ServiceType:     req.ServiceType,
		DurationMinutes: req.DurationMinutes,
		EnergyKwh:       req.EnergyKwh,
	})
	if err != nil {
		return nil, errors.Wrap(err, "fare calculation")
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	if h.balanceUser.Cmp(fare.FareWei) < 0 {
		return nil, fmt.Errorf("잔액 부족: 보유 %s USDC, 필요 %s USDC",
			pricing.WeiToUsdc(h.balanceUser), fare.FareUsdc)
	}

	// ★ ch.Update — custodial이므로 userNode의 updateHandler가 자동 서명
	err = h.ch.Update(ctx, func(state *channel.State) {
		state.Allocation.TransferBalance(
			channel.Index(0), // from: operator (custodial 구조에서 operator가 user 잔액 보유)
			channel.Index(1), // to: user slot
			m.node.USDCAsset,
			fare.FareWei,
		)
	})
	if err != nil {
		return nil, errors.Wrap(err, "ch.Update (off-chain charge)")
	}

	s := h.ch.State()
	h.latestNonce     = uint64(s.Version)
	h.latestStateHash = stateDigest(s)
	h.balanceUser     = s.Allocation.Balance(0, m.node.USDCAsset)
	h.balanceOp       = s.Allocation.Balance(1, m.node.USDCAsset)

	return &ChargeResult{
		FareUsdc:    fare.FareUsdc,
		PolicyHash:  fare.PolicyHash,
		NewNonce:    h.latestNonce,
		StateHash:   h.latestStateHash,
		BalanceUser: pricing.WeiToUsdc(h.balanceUser),
		BalanceOp:   pricing.WeiToUsdc(h.balanceOp),
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// FinalUpdateAndAdjust — 종료 직전 최종 상태
// ────────────────────────────────────────────────────────────────────

type FinalUpdateResult struct {
	FinalStateHash   string
	FinalNonce       uint64
	FinalBalanceUser string
	FinalBalanceOp   string
	TotalFareUsdc    string
}

func (m *Manager) FinalUpdateAndAdjust(ctx context.Context, channelID, totalChargedUsdc, creditUsdc string) (*FinalUpdateResult, error) {
	h, err := m.get(channelID)
	if err != nil {
		return nil, err
	}

	netUsdc, creditWei := pricing.FinalFare(totalChargedUsdc, creditUsdc)

	m.log.WithFields(logrus.Fields{
		"channel":  channelID,
		"charged":  totalChargedUsdc,
		"credit":   creditUsdc,
		"net_fare": netUsdc,
	}).Info("[Channel] FinalUpdateAndAdjust")

	h.mu.Lock()
	defer h.mu.Unlock()

	err = h.ch.Update(ctx, func(state *channel.State) {
		if creditWei != nil && creditWei.Sign() > 0 {
			state.Allocation.TransferBalance(
				channel.Index(1),
				channel.Index(0),
				m.node.USDCAsset,
				creditWei,
			)
		}
		state.IsFinal = true
	})
	if err != nil {
		return nil, errors.Wrap(err, "ch.Update (final + IsFinal=true)")
	}

	s := h.ch.State()
	h.latestNonce     = uint64(s.Version)
	h.latestStateHash = stateDigest(s)
	h.balanceUser     = s.Allocation.Balance(0, m.node.USDCAsset)
	h.balanceOp       = s.Allocation.Balance(1, m.node.USDCAsset)

	return &FinalUpdateResult{
		FinalStateHash:   h.latestStateHash,
		FinalNonce:       h.latestNonce,
		FinalBalanceUser: pricing.WeiToUsdc(h.balanceUser),
		FinalBalanceOp:   pricing.WeiToUsdc(h.balanceOp),
		TotalFareUsdc:    netUsdc,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// CloseChannel — 온체인 정산 (변경 없음)
// ────────────────────────────────────────────────────────────────────

type CloseResult struct {
	ChannelID   string
	FinalFare   string
	FinalRefund string
	SettledAt   time.Time
}

func (m *Manager) CloseChannel(ctx context.Context, channelID string) (*CloseResult, error) {
	h, err := m.get(channelID)
	if err != nil {
		return nil, err
	}

	m.log.WithField("channel_id", channelID).Info("[Channel] CloseChannel → ch.Settle()")

	if err := h.ch.Settle(ctx, false); err != nil {
		return nil, errors.Wrap(err, "ch.Settle")
	}
	h.ch.Close()

	fare   := pricing.WeiToUsdc(h.balanceOp)
	refund := pricing.WeiToUsdc(h.balanceUser)

	m.mu.Lock()
	delete(m.channels, channelID)
	m.mu.Unlock()

	m.log.WithFields(logrus.Fields{
		"channel_id": channelID,
		"fare":       fare,
		"refund":     refund,
	}).Info("[Channel] ✅ settled")

	return &CloseResult{
		ChannelID:   channelID,
		FinalFare:   fare,
		FinalRefund: refund,
		SettledAt:   time.Now(),
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// InitiateDispute (변경 없음)
// ────────────────────────────────────────────────────────────────────

func (m *Manager) InitiateDispute(ctx context.Context, channelID string) error {
	h, err := m.get(channelID)
	if err != nil {
		return err
	}
	return errors.Wrap(
		h.ch.ForceUpdate(ctx, func(state *channel.State) { state.IsFinal = true }),
		"ForceUpdate (dispute register)",
	)
}

// GetStatus — 채널 상태 조회
func (m *Manager) GetStatus(channelID string) (*Handle, error) {
	return m.get(channelID)
}

// ────────────────────────────────────────────────────────────────────
// StartHandling (변경 없음)
// ────────────────────────────────────────────────────────────────────

func (m *Manager) StartHandling() {
	go m.node.Client.Handle(
		&proposalHandler{manager: m, log: m.log},
		&updateHandler{log: m.log},
	)
}

// proposalHandler — 운영자 측 (외부 제안 거부)
type proposalHandler struct {
	manager *Manager
	log     *logrus.Logger
}

func (h *proposalHandler) HandleProposal(p client.ChannelProposal, r *client.ProposalResponder) {
	h.log.Warn("[Channel] incoming proposal — rejecting (operator is always proposer)")
	r.Reject(context.TODO(), "operator does not accept incoming proposals") //nolint:errcheck
}

// updateHandler — 운영자 측 업데이트 핸들러
type updateHandler struct {
	log *logrus.Logger
}

func (h *updateHandler) HandleUpdate(cur *channel.State, next client.ChannelUpdate, r *client.UpdateResponder) {
	err := func() error {
		receiverIdx := channel.Index(1 - int(next.ActorIdx))
		curBal  := cur.Allocation.Balance(receiverIdx, cur.Assets[0])
		nextBal := next.State.Allocation.Balance(receiverIdx, cur.Assets[0])
		if nextBal.Cmp(curBal) < 0 {
			return fmt.Errorf("balance decreased: %s → %s", curBal, nextBal)
		}
		return nil
	}()
	if err != nil {
		h.log.WithError(err).Warn("[Channel] rejecting update")
		r.Reject(context.TODO(), err.Error()) //nolint:errcheck
		return
	}
	if err := r.Accept(context.TODO()); err != nil {
		h.log.WithError(err).Error("[Channel] failed to accept update")
	}
}

// ★ autoAcceptProposalHandler — custodial 사용자 노드용 (모든 제안 자동 수락)
type autoAcceptProposalHandler struct {
	log         *logrus.Logger
	participant map[wallet.BackendID]wallet.Address // user custodial eth address
}

func (h *autoAcceptProposalHandler) HandleProposal(p client.ChannelProposal, r *client.ProposalResponder) {
	h.log.Info("[Channel] custodial user: auto-accepting channel proposal")
	lcp, ok := p.(*client.LedgerChannelProposalMsg)
	if !ok {
		h.log.Warn("[Channel] custodial user: unknown proposal type, rejecting")
		r.Reject(context.TODO(), "unknown proposal type") //nolint:errcheck
		return
	}
	acc := lcp.Accept(h.participant, client.WithRandomNonce())
	if _, err := r.Accept(context.TODO(), acc); err != nil {
		h.log.WithError(err).Error("[Channel] custodial user: failed to accept proposal")
	}
}

// ★ autoAcceptUpdateHandler — custodial 사용자 노드용 (모든 업데이트 자동 수락)
type autoAcceptUpdateHandler struct {
	log *logrus.Logger
}

func (h *autoAcceptUpdateHandler) HandleUpdate(_ *channel.State, _ client.ChannelUpdate, r *client.UpdateResponder) {
	h.log.Debug("[Channel] custodial user: auto-accepting update")
	if err := r.Accept(context.TODO()); err != nil {
		h.log.WithError(err).Error("[Channel] custodial user: failed to accept update")
	}
}

// adjEventHandler (변경 없음)
type adjEventHandler struct {
	log       *logrus.Logger
	channelID channel.ID
}

func (h *adjEventHandler) HandleAdjudicatorEvent(e channel.AdjudicatorEvent) {
	h.log.WithFields(logrus.Fields{
		"channel": fmt.Sprintf("%x", h.channelID),
		"type":    fmt.Sprintf("%T", e),
	}).Info("[Channel] on-chain adjudicator event")

	switch e.(type) {
	case *channel.RegisteredEvent:
		h.log.Warn("[Channel] RegisteredEvent — dispute detected")
	case *channel.ConcludedEvent:
		h.log.Info("[Channel] ConcludedEvent — concluded on-chain")
	}
}

// ────────────────────────────────────────────────────────────────────
// 헬퍼
// ────────────────────────────────────────────────────────────────────

func (m *Manager) get(id string) (*Handle, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	h, ok := m.channels[id]
	if !ok {
		return nil, fmt.Errorf("channel not found: %s", id)
	}
	return h, nil
}

func stateDigest(s *channel.State) string {
	return fmt.Sprintf("0x%x_v%d", s.ID, s.Version)
}

func usdcToWei(usdc string) *big.Int {
	bf, _, err := big.ParseFloat(usdc, 10, 128, big.ToNearestEven)
	if err != nil {
		return big.NewInt(0)
	}
	bf.Mul(bf, new(big.Float).SetPrec(128).SetInt64(1_000_000))
	result, _ := bf.Int(nil)
	return result
}


