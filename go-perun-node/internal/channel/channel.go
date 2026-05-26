// Package channel은 perun-eth-backend 기반의 실제 채널 생명주기를 관리합니다.
//
// PerunNode(setup 패키지)에서 초기화된 client.Client를 받아:
//   OpenChannel  → client.ProposeChannel() [perun-eth-backend Funder가 USDC approve+deposit]
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
	ethwallet "github.com/hyperledger-labs/perun-eth-backend/wallet"

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

	node    *setup.PerunNode   // setup 패키지에서 초기화된 노드
	pricing *pricing.Engine
	log     *logrus.Logger
}

func NewManager(node *setup.PerunNode, log *logrus.Logger) *Manager {
	return &Manager{
		channels: make(map[string]*Handle),
		node:     node,
		pricing:  pricing.NewEngine(),
		log:      log,
	}
}

// Handle — 단일 채널 래퍼
type Handle struct {
	mu sync.Mutex

	ChannelID    string
	SessionID    string
	UserAddress  string
	DepositUsdc  string
	HoldDeadline int64

	// ★ go-perun 실제 채널 객체
	// Update(), Settle(), State(), Watch() 등 직접 호출
	ch *client.Channel

	// 상태 캐시
	latestNonce     uint64
	latestStateHash string
	balanceUser     *big.Int
	balanceOp       *big.Int
}

// ────────────────────────────────────────────────────────────────────
// OpenChannel
//
// perun-eth-backend 흐름:
//   1. client.ProposeChannel(proposal)
//      → P2P 메시지로 상대방에게 채널 제안 (libp2p)
//      → 수락 시 Funder.Fund() 호출
//         → ERC20Depositor.Deposit()
//            → USDC.approve(AssetHolder, amount)  TX ①
//            → AssetHolder.deposit(fundingID, amount) TX ②
//   2. ch.Watch() 고루틴 시작 (분쟁 자동 감지)
// ────────────────────────────────────────────────────────────────────

type OpenParams struct {
	SessionID    string
	UserAddress  string
	UserWireAddr map[wallet.BackendID]wire.Address // 사용자 P2P 주소
	DepositUsdc  string                             // 사용자 예치금
	HoldDeadline int64
}

type OpenResult struct {
	ChannelID   string
	StateHash   string
	InitNonce   uint64
}

func (m *Manager) OpenChannel(ctx context.Context, p OpenParams) (*OpenResult, error) {
	m.log.WithFields(logrus.Fields{
		"session": p.SessionID,
		"user":    p.UserAddress,
		"deposit": p.DepositUsdc,
	}).Info("[Channel] OpenChannel")

	depositWei := usdcToWei(p.DepositUsdc)

	// ── 초기 자금 배분 ─────────────────────────────────────────────────
	// participants[0] = operator (idx=0) : 예치 0
	// participants[1] = user     (idx=1) : 예치 depositUsdc
	initAlloc := channel.NewAllocation(
		2, // 2인 채널
		[]wallet.BackendID{ethwallet.BackendID},
		m.node.USDCAsset,
	)
	initAlloc.SetAssetBalances(m.node.USDCAsset, []channel.Bal{
		big.NewInt(0), // operator
		depositWei,    // user
	})

	// ── 채널 제안 구성 ─────────────────────────────────────────────────
	// challengeDuration: Base Sepolia 분쟁 챌린지 기간 (초)
	// 120초 = 약 60블록 (Base L2 ~2초/블록)
	challengeDuration := uint64(120)

	peers := []map[wallet.BackendID]wire.Address{
		m.node.WireAddress, // operator (proposer, idx=0)
		p.UserWireAddr,     // user     (proposee, idx=1)
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

	// ── go-perun ProposeChannel ─────────────────────────────────────────
	// 내부적으로 perun-eth-backend Funder.Fund() → ERC20Depositor.Deposit() 호출
	ch, err := m.node.Client.ProposeChannel(ctx, proposal)
	if err != nil {
		return nil, errors.Wrap(err, "proposing channel (perun-eth-backend Funder will approve+deposit USDC)")
	}

	// ── Dispute Watcher 시작 ────────────────────────────────────────────
	// 상대방이 오래된 상태로 Register() 호출 시 자동으로 최신 상태 제출
	go func() {
		if err := ch.Watch(&adjEventHandler{log: m.log, channelID: ch.ID()}); err != nil {
			m.log.WithError(err).Warn("[Channel] watcher exited")
		}
	}()

	// ── 핸들 등록 ───────────────────────────────────────────────────────
	state := ch.State()
	h := &Handle{
		ChannelID:       fmt.Sprintf("0x%x", ch.ID()),
		SessionID:       p.SessionID,
		UserAddress:     p.UserAddress,
		DepositUsdc:     p.DepositUsdc,
		HoldDeadline:    p.HoldDeadline,
		ch:              ch,
		latestNonce:     uint64(state.Version),
		latestStateHash: stateDigest(state),
		balanceUser:     new(big.Int).Set(depositWei),
		balanceOp:       big.NewInt(0),
	}

	m.mu.Lock()
	m.channels[h.ChannelID] = h
	m.mu.Unlock()

	m.log.WithField("channel_id", h.ChannelID).Info("[Channel] ✅ opened")
	return &OpenResult{
		ChannelID: h.ChannelID,
		StateHash: h.latestStateHash,
		InitNonce: h.latestNonce,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// ChargeUsage — 오프체인 요금 청구
//
// ★ 진짜 오프체인 마이크로페이먼트
// perun-eth-backend 흐름:
//   ch.Update(ctx, func(state) { TransferBalance(user→operator, fareWei) })
//     → 운영자가 새 state proposal 생성 + 서명
//     → P2P(libp2p)로 user에게 전송
//     → user UpdateHandler가 검증 후 서명
//     → 양측 서명된 state 로컬 보관 (온체인 TX 없음)
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

	// ★ ch.Update — 실제 Perun 오프체인 업데이트
	// 온체인 TX 없이 양측 서명 교환만으로 잔액 변경
	err = h.ch.Update(ctx, func(state *channel.State) {
		// user(idx=1) → operator(idx=0) 방향으로 fareWei 이동
		state.Allocation.TransferBalance(
			channel.Index(1), // from: user
			channel.Index(0), // to: operator
			m.node.USDCAsset,
			fare.FareWei,
		)
	})
	if err != nil {
		return nil, errors.Wrap(err, "ch.Update (off-chain charge)")
	}

	// 상태 캐시 갱신
	s := h.ch.State()
	h.latestNonce     = uint64(s.Version)
	h.latestStateHash = stateDigest(s)
	h.balanceUser     = s.Allocation.Balance(1, m.node.USDCAsset)
	h.balanceOp       = s.Allocation.Balance(0, m.node.USDCAsset)

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
//
// perun-eth-backend 흐름:
//   ch.Update(ctx, func(state) {
//       // credit 있으면 operator→user 환급
//       TransferBalance(operator→user, creditWei)
//       // ★ IsFinal = true → ch.Settle() 즉시 가능 (challenge 불필요)
//       state.IsFinal = true
//   })
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
		// credit 환급 (있을 때만)
		if creditWei != nil && creditWei.Sign() > 0 {
			state.Allocation.TransferBalance(
				channel.Index(0), // from: operator
				channel.Index(1), // to: user
				m.node.USDCAsset,
				creditWei,
			)
		}
		// ★ IsFinal = true
		// 이 플래그가 설정된 상태에 양측이 서명하면
		// ch.Settle()이 challenge period 없이 즉시 온체인 정산 가능
		state.IsFinal = true
	})
	if err != nil {
		return nil, errors.Wrap(err, "ch.Update (final + IsFinal=true)")
	}

	s := h.ch.State()
	h.latestNonce     = uint64(s.Version)
	h.latestStateHash = stateDigest(s)
	h.balanceUser     = s.Allocation.Balance(1, m.node.USDCAsset)
	h.balanceOp       = s.Allocation.Balance(0, m.node.USDCAsset)

	return &FinalUpdateResult{
		FinalStateHash:   h.latestStateHash,
		FinalNonce:       h.latestNonce,
		FinalBalanceUser: pricing.WeiToUsdc(h.balanceUser),
		FinalBalanceOp:   pricing.WeiToUsdc(h.balanceOp),
		TotalFareUsdc:    netUsdc,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// CloseChannel — 온체인 정산
//
// perun-eth-backend 흐름:
//   ch.Settle(ctx, secondary=false)
//     → Adjudicator.conclude() (IsFinal=true이면 즉시)
//     → AssetHolder.setOutcome() (Adjudicator가 내부 호출)
//     → Adjudicator.withdraw()
//        → AssetHolder.withdraw(WithdrawalAuth) TX
//           → USDC.transfer(receiver, operatorBal)  운영자 수령
//           → USDC.transfer(user, userBal)           사용자 환급
// ────────────────────────────────────────────────────────────────────

type CloseResult struct {
	ChannelID    string
	FinalFare    string // 운영자 수령액
	FinalRefund  string // 사용자 환급액
	SettledAt    time.Time
}

func (m *Manager) CloseChannel(ctx context.Context, channelID string) (*CloseResult, error) {
	h, err := m.get(channelID)
	if err != nil {
		return nil, err
	}

	m.log.WithField("channel_id", channelID).Info("[Channel] CloseChannel → ch.Settle()")

	// secondary=false: 이 노드(operator)가 정산 주도
	// perun-eth-backend Adjudicator.Withdraw() → AssetHolder TX 전송
	if err := h.ch.Settle(ctx, false); err != nil {
		return nil, errors.Wrap(err, "ch.Settle (perun-eth-backend Adjudicator.Withdraw)")
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
// InitiateDispute — 수동 강제 분쟁
//
// 사용 시나리오: 사용자가 응답 없음, 협력 종료 실패
// perun-eth-backend 흐름:
//   ch.ForceUpdate() → Adjudicator.register(latestSignedState) TX
//   → challenge period 후 Adjudicator.conclude() + withdraw() 가능
// ────────────────────────────────────────────────────────────────────

func (m *Manager) InitiateDispute(ctx context.Context, channelID string) error {
	h, err := m.get(channelID)
	if err != nil {
		return err
	}

	m.log.WithFields(logrus.Fields{
		"channel_id": channelID,
		"nonce":      h.latestNonce,
	}).Warn("[Channel] InitiateDispute — registering latest state on-chain")

	return errors.Wrap(
		h.ch.ForceUpdate(ctx, func(state *channel.State) {
			state.IsFinal = true
		}),
		"ForceUpdate (dispute register)",
	)
}

// GetStatus — 채널 상태 조회
func (m *Manager) GetStatus(channelID string) (*Handle, error) {
	return m.get(channelID)
}

// ────────────────────────────────────────────────────────────────────
// UpdateHandler + ProposalHandler 구현
// go-perun은 Handle(ph, uh)로 루프를 돌며 들어오는 요청을 처리합니다.
// ────────────────────────────────────────────────────────────────────

// StartHandling — go-perun 요청 핸들러 루프 시작 (goroutine)
func (m *Manager) StartHandling() {
	go m.node.Client.Handle(
		&proposalHandler{manager: m, log: m.log},
		&updateHandler{log: m.log},
	)
}

// proposalHandler — 들어오는 채널 제안 처리
// (operator가 proposer이므로 일반적으로 이 경로는 없지만 구현 필요)
type proposalHandler struct {
	manager *Manager
	log     *logrus.Logger
}

func (h *proposalHandler) HandleProposal(p client.ChannelProposal, r *client.ProposalResponder) {
	// SmartCity에서 operator가 항상 proposer이므로 들어오는 제안은 거부
	h.log.Warn("[Channel] incoming proposal received — rejecting (operator is always proposer)")
	r.Reject(context.TODO(), "operator does not accept incoming proposals") //nolint:errcheck
}

// updateHandler — 들어오는 상태 업데이트 요청 처리
// perun-examples/payment-channel/client/handle.go 패턴
type updateHandler struct {
	log *logrus.Logger
}

func (h *updateHandler) HandleUpdate(cur *channel.State, next client.ChannelUpdate, r *client.UpdateResponder) {
	// 잔액이 줄어들지 않는 업데이트만 수락
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

// adjEventHandler — 온체인 이벤트 핸들러
// ch.Watch()에 전달 — 분쟁 이벤트 수신 시 로깅
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
		h.log.Warn("[Channel] RegisteredEvent — dispute detected, watcher auto-refuting")
	case *channel.ConcludedEvent:
		h.log.Info("[Channel] ConcludedEvent — channel concluded on-chain")
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
	var f float64
	fmt.Sscanf(usdc, "%f", &f)
	bf := new(big.Float).SetPrec(128).SetFloat64(f)
	bf.Mul(bf, new(big.Float).SetPrec(128).SetInt64(1_000_000))
	result, _ := bf.Int(nil)
	return result
}
