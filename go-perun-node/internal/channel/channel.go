// Package channel은 go-perun SDK를 직접 호출하는 계층입니다.
//
// ★ 핵심: 이 파일의 모든 함수가 실제 go-perun API를 래핑합니다.
//
//   openChannel    → client.ProposeChannel()
//   proposeUpdate  → ch.Update(ctx, updaterFn)
//   finalUpdate    → ch.Update(ctx, func{ state.IsFinal=true })
//   closeChannel   → ch.Settle(ctx, secondary=false)
//   disputeChannel → ch.registerDispute(ctx)  [forceClose]
//   watchChannel   → ch.Watch(handler)        [자동 분쟁 대응]
//
// Node.js perunClient.js는 gRPC로 이 계층을 호출합니다.
package channel

import (
	"context"
	"fmt"
	"math/big"
	"sync"
	"time"

	"github.com/pkg/errors"
	"github.com/sirupsen/logrus"

	// ── go-perun SDK 핵심 패키지 ────────────────────────────────────
	goperun "perun.network/go-perun/client"
	"perun.network/go-perun/channel"
	"perun.network/go-perun/wallet"
	"perun.network/go-perun/wire"
	// ────────────────────────────────────────────────────────────────

	"smartcity/go-perun-node/internal/pricing"
)

// ────────────────────────────────────────────────────────────────────
// Manager — go-perun 채널 생명주기 관리
// ────────────────────────────────────────────────────────────────────

// Manager는 운영자(operator) 측 Perun 클라이언트를 보유하고
// 모든 활성 채널을 추적합니다.
type Manager struct {
	mu       sync.RWMutex
	channels map[string]*ChannelHandle // channelId → handle

	// go-perun 클라이언트 — 이 노드(operator)의 핵심 객체
	// goperun.Client.ProposeChannel(), Handle() 등을 직접 호출합니다.
	perunClient *goperun.Client

	// 운영자 자신의 wire 주소 (P2P 통신 식별자)
	operatorWireAddr map[wallet.BackendID]wire.Address

	// USDC asset 식별자 (Perun Allocation.Assets에 등록됨)
	usdcAsset channel.Asset

	// 요금 계산 엔진
	pricing *pricing.Engine

	log *logrus.Logger
}

// ChannelHandle은 단일 Perun 채널 + 메타데이터를 래핑합니다.
type ChannelHandle struct {
	mu sync.Mutex

	ChannelID    string
	SessionID    string
	UserAddress  string
	DepositUsdc  string
	HoldDeadline int64

	// go-perun의 실제 채널 객체
	// ch.Update(), ch.Settle(), ch.State() 등을 직접 사용합니다.
	ch *goperun.Channel

	// 현재 상태 캐시 (빠른 조회용)
	latestNonce    uint64
	latestStateHash string
	balanceUser    *big.Int
	balanceOp      *big.Int
}

// NewManager는 Manager를 초기화합니다.
// perunClient는 Setup()에서 주입됩니다.
func NewManager(log *logrus.Logger) *Manager {
	return &Manager{
		channels: make(map[string]*ChannelHandle),
		pricing:  pricing.NewEngine(),
		log:      log,
	}
}

// SetPerunClient는 초기화 완료된 go-perun Client를 주입합니다.
func (m *Manager) SetPerunClient(c *goperun.Client, operatorAddr map[wallet.BackendID]wire.Address, asset channel.Asset) {
	m.perunClient    = c
	m.operatorWireAddr = operatorAddr
	m.usdcAsset      = asset
}

// ────────────────────────────────────────────────────────────────────
// OpenChannel — Perun 채널 개설
//
// go-perun API 사용:
//   client.ProposeChannel(ctx, proposal)
//     → 상대방(사용자 Perun 노드 또는 MetaMask 기반 SDK)에게 채널 제안
//     → 수락 시 on-chain Funder.Fund() 호출 → USDC AssetHolder에 잠금
//     → channel.ID = keccak256(params) — 결정론적 생성
//
// 현재 구현에서 사용자 측 go-perun 클라이언트가 없는 경우:
//   → MetaMask 서명 기반 approve+userDeposit을 operator가 accept로 처리
//   → 이 경우 AcceptChannel() 모드로 동작
// ────────────────────────────────────────────────────────────────────
func (m *Manager) OpenChannel(ctx context.Context, params OpenChannelParams) (*ChannelHandle, error) {
	m.log.WithFields(logrus.Fields{
		"user":    params.UserAddress,
		"deposit": params.DepositUsdc,
	}).Info("[Channel] OpenChannel")

	if m.perunClient == nil {
		return nil, errors.New("perun client not initialized")
	}

	// ── 초기 잔액 설정 ──────────────────────────────────────────────
	// Perun 구조: user가 depositUsdc를 예치, operator는 0으로 시작
	// (운영자 담보는 별도 operator deposit으로 처리)
	depositWei := usdcToWei(params.DepositUsdc)

	// ── 채널 제안 구성 ──────────────────────────────────────────────
	// Perun LedgerChannelProposal:
	//   participants[0] = operator (proposer, idx=0)
	//   participants[1] = user (proposee, idx=1)
	initAlloc := channel.NewAllocation(
		2, // 참여자 수
		[]wallet.BackendID{0}, // Backend 0 = Ethereum
		m.usdcAsset,
	)
	// operator 초기 잔액 = 0 (서비스 제공자이므로 예치 불필요)
	// user 초기 잔액 = depositUsdc
	initAlloc.SetAssetBalances(m.usdcAsset, []channel.Bal{
		big.NewInt(0), // operator (idx=0)
		depositWei,    // user (idx=1)
	})

	// challengeDuration: 온체인 분쟁 챌린지 시간 (초)
	// Base Sepolia: ~2초 블록타임 → 60블록 ≈ 120초
	challengeDuration := uint64(120)

	proposal, err := goperun.NewLedgerChannelProposal(
		challengeDuration,
		m.operatorWireAddr, // operator의 wire 주소
		initAlloc,
		// peers: operator(자신) + user
		[]map[wallet.BackendID]wire.Address{
			m.operatorWireAddr,
			params.UserWireAddr,
		},
	)
	if err != nil {
		return nil, errors.Wrap(err, "creating channel proposal")
	}

	// ── go-perun ProposeChannel 호출 ────────────────────────────────
	// 이 호출이 P2P 메시지로 user에게 채널 제안을 보내고
	// user가 Accept하면 on-chain 펀딩이 진행됩니다.
	ch, err := m.perunClient.ProposeChannel(ctx, proposal)
	if err != nil {
		return nil, errors.Wrap(err, "proposing channel")
	}

	// ── Dispute Watcher 시작 ────────────────────────────────────────
	// ch.Watch()는 on-chain 이벤트를 감시하며
	// 상대방이 오래된 상태로 분쟁을 제기하면 자동으로 최신 상태를 제출합니다.
	go func() {
		if err := ch.Watch(newEventHandler(m.log, ch.ID())); err != nil {
			m.log.WithError(err).Warn("[Channel] watcher returned")
		}
	}()

	// ── 핸들 등록 ───────────────────────────────────────────────────
	state := ch.State()
	handle := &ChannelHandle{
		ChannelID:    fmt.Sprintf("0x%x", ch.ID()),
		SessionID:    params.SessionID,
		UserAddress:  params.UserAddress,
		DepositUsdc:  params.DepositUsdc,
		HoldDeadline: params.HoldDeadline,
		ch:           ch,
		latestNonce:  uint64(state.Version),
		balanceUser:  new(big.Int).Set(depositWei),
		balanceOp:    big.NewInt(0),
	}
	handle.latestStateHash = stateHash(state)

	m.mu.Lock()
	m.channels[handle.ChannelID] = handle
	m.mu.Unlock()

	m.log.WithField("channel_id", handle.ChannelID).Info("[Channel] opened")
	return handle, nil
}

// ────────────────────────────────────────────────────────────────────
// ProposeUsageUpdate — 오프체인 요금 청구 제안
//
// go-perun API 사용:
//   ch.Update(ctx, func(state *channel.State) {
//       state.Allocation.TransferBalance(user, operator, asset, fareWei)
//   })
//
// 흐름:
//   1) 요금 계산 (pricing.Engine)
//   2) ch.Update() 호출 → go-perun이 새 state proposal 생성
//   3) 양측(operator+user)의 서명 교환 (go-perun P2P)
//   4) 서명된 state가 양측에 저장 → 분쟁 시 사용
//
// ★ 이것이 진짜 "오프체인 마이크로페이먼트"입니다.
//   온체인 TX 없이 잔액이 변경되고 양측 서명으로 보증됩니다.
// ────────────────────────────────────────────────────────────────────
func (m *Manager) ProposeUsageUpdate(ctx context.Context, req UpdateRequest) (*UpdateResult, error) {
	handle, err := m.getHandle(req.ChannelID)
	if err != nil {
		return nil, err
	}

	// 1. 요금 계산
	fare, err := m.pricing.CalculateFare(pricing.UsageDelta{
		DurationMinutes: req.DurationMinutes,
		EnergyKwh:       req.EnergyKwh,
		ServiceType:     req.ServiceType,
	})
	if err != nil {
		return nil, errors.Wrap(err, "calculating fare")
	}

	m.log.WithFields(logrus.Fields{
		"channel_id": req.ChannelID,
		"fare_usdc":  fare.FareUsdc,
		"policy":     fare.PolicyHash,
	}).Info("[Channel] ProposeUsageUpdate")

	handle.mu.Lock()
	defer handle.mu.Unlock()

	curUserBal := new(big.Int).Set(handle.balanceUser)

	// 잔액 부족 확인
	if curUserBal.Cmp(fare.FareWei) < 0 {
		return nil, fmt.Errorf("insufficient balance: have %s, need %s",
			pricing.WeiToUsdc(curUserBal), fare.FareUsdc)
	}

	// 2. go-perun ch.Update() 호출
	//    operator(idx=0)가 user(idx=1)에게 요금 청구를 제안합니다.
	//    UpdateHandler가 자동 수락하도록 설정되어 있습니다.
	err = handle.ch.Update(ctx, func(state *channel.State) {
		// ★ Perun 핵심: TransferBalance(from=user, to=operator, asset, amount)
		// user잔액 -= fareWei, operator잔액 += fareWei
		state.Allocation.TransferBalance(
			channel.Index(1), // from: user (idx=1)
			channel.Index(0), // to: operator (idx=0)
			m.usdcAsset,
			fare.FareWei,
		)
	})
	if err != nil {
		return nil, errors.Wrap(err, "go-perun ch.Update failed")
	}

	// 3. 업데이트된 상태 캐시
	newState := handle.ch.State()
	handle.latestNonce    = uint64(newState.Version)
	handle.latestStateHash = stateHash(newState)
	handle.balanceUser    = newState.Allocation.Balance(1, m.usdcAsset)
	handle.balanceOp      = newState.Allocation.Balance(0, m.usdcAsset)

	return &UpdateResult{
		NewNonce:       handle.latestNonce,
		StateHash:      handle.latestStateHash,
		FareUsdc:       fare.FareUsdc,
		PolicyHash:     fare.PolicyHash,
		BalanceUser:    pricing.WeiToUsdc(handle.balanceUser),
		BalanceOp:      pricing.WeiToUsdc(handle.balanceOp),
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// FinalUpdateAndAdjust — 종료 직전 최종 상태 확정
//
// go-perun API 사용:
//   ch.Update(ctx, func(state *channel.State) {
//       // credit 차감 반영
//       state.Allocation.TransferBalance(operator, user, asset, creditWei)
//       // 채널 최종화
//       state.IsFinal = true  ← 이 플래그가 ch.Settle() 가능하게 함
//   })
//
// IsFinal=true가 된 채널은:
//   - 추가 Update 불가
//   - ch.Settle()로 즉시 온체인 출금 가능 (challenge period 불필요)
// ────────────────────────────────────────────────────────────────────
func (m *Manager) FinalUpdateAndAdjust(ctx context.Context, channelID, creditUsdc, totalChargedUsdc string) (*FinalUpdateResult, error) {
	handle, err := m.getHandle(channelID)
	if err != nil {
		return nil, err
	}

	// 최종 요금 = 누적 charged - 누적 credit
	netUsdc, netWei := pricing.FinalFare(totalChargedUsdc, creditUsdc)

	m.log.WithFields(logrus.Fields{
		"channel_id":   channelID,
		"charged_usdc": totalChargedUsdc,
		"credit_usdc":  creditUsdc,
		"net_fare":     netUsdc,
	}).Info("[Channel] FinalUpdateAndAdjust")

	handle.mu.Lock()
	defer handle.mu.Unlock()

	// go-perun: 최종 상태 업데이트
	// credit이 있으면 operator → user 방향 transfer 추가
	var creditWei *big.Int
	if creditUsdc != "0" && creditUsdc != "0.000000" {
		_, creditWei = pricing.FinalFare("0", creditUsdc) // credit 절댓값
		creditWei.Neg(creditWei)
	}

	err = handle.ch.Update(ctx, func(state *channel.State) {
		// credit 반영: operator → user 환급
		if creditWei != nil && creditWei.Sign() < 0 {
			posCredit := new(big.Int).Neg(creditWei)
			state.Allocation.TransferBalance(
				channel.Index(0), // from: operator
				channel.Index(1), // to: user
				m.usdcAsset,
				posCredit,
			)
		}

		// ★ IsFinal = true → 이후 ch.Settle() 가능
		//   양측이 이 상태에 서명하면 온체인 challenge 없이 즉시 정산됩니다.
		state.IsFinal = true
	})
	if err != nil {
		return nil, errors.Wrap(err, "go-perun final update failed")
	}

	// 최종 상태 캐시
	finalState := handle.ch.State()
	handle.latestNonce     = uint64(finalState.Version)
	handle.latestStateHash = stateHash(finalState)
	handle.balanceUser     = finalState.Allocation.Balance(1, m.usdcAsset)
	handle.balanceOp       = finalState.Allocation.Balance(0, m.usdcAsset)

	_ = netWei // (escrowPayoutService에서 사용)

	return &FinalUpdateResult{
		FinalStateHash:   handle.latestStateHash,
		FinalNonce:       handle.latestNonce,
		FinalBalanceUser: pricing.WeiToUsdc(handle.balanceUser),
		FinalBalanceOp:   pricing.WeiToUsdc(handle.balanceOp),
		TotalFareUsdc:    netUsdc,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// CloseChannel — 온체인 정산 (Settle)
//
// go-perun API 사용:
//   ch.Settle(ctx, secondary=false)
//     → Adjudicator.Withdraw() 호출
//     → AssetHolder 컨트랙트에서 각자 지갑으로 인출
//     → operator: fare USDC 수령
//     → user: (deposit - fare) USDC 환급
//
// 전제조건: FinalUpdateAndAdjust()가 먼저 호출되어 IsFinal=true 상태여야 합니다.
// ────────────────────────────────────────────────────────────────────
func (m *Manager) CloseChannel(ctx context.Context, channelID string) (*CloseResult, error) {
	handle, err := m.getHandle(channelID)
	if err != nil {
		return nil, err
	}

	m.log.WithField("channel_id", channelID).Info("[Channel] CloseChannel — calling ch.Settle()")

	// go-perun ch.Settle() 호출
	// secondary=false: 이 노드(operator)가 정산을 주도합니다.
	// secondary=true: 상대방이 정산을 주도하면 이쪽은 따라가기만 합니다.
	if err := handle.ch.Settle(ctx, false); err != nil {
		return nil, errors.Wrap(err, "go-perun ch.Settle failed")
	}

	// 채널 정리
	handle.ch.Close()

	m.mu.Lock()
	delete(m.channels, channelID)
	m.mu.Unlock()

	m.log.WithField("channel_id", channelID).Info("[Channel] settled & closed")

	return &CloseResult{
		ChannelID:    channelID,
		FinalBalance: pricing.WeiToUsdc(handle.balanceUser),
		SettledAt:    time.Now(),
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// InitiateDispute — 강제 분쟁 등록 (수동 트리거)
//
// go-perun API 사용:
//   ch.registerDispute(ctx)  [내부적으로]
//     → Adjudicator.Register(ctx, req, subStates)
//     → 최신 서명 상태를 온체인에 제출
//     → 상대방이 challenge period 내에 더 높은 nonce 상태를 제출하지 않으면 이 상태로 정산
//
// 사용 시나리오:
//   - 사용자가 앱을 닫고 응답하지 않을 때
//   - 협력 종료(cooperative close) 실패 시
//   - 운영자 콘솔에서 수동으로 트리거
// ────────────────────────────────────────────────────────────────────
func (m *Manager) InitiateDispute(ctx context.Context, channelID string) (*DisputeResult, error) {
	handle, err := m.getHandle(channelID)
	if err != nil {
		return nil, err
	}

	m.log.WithFields(logrus.Fields{
		"channel_id": channelID,
		"nonce":      handle.latestNonce,
	}).Warn("[Channel] InitiateDispute — registering on-chain")

	// go-perun ForceUpdate or registerDispute
	// 분쟁 등록: 최신 서명 상태를 Adjudicator 컨트랙트에 제출
	// challenge period 후 Withdraw 가능
	err = handle.ch.ForceUpdate(ctx, func(state *channel.State) {
		state.IsFinal = true // 최종화 강제
	})
	if err != nil {
		// ForceUpdate 실패 시 Watch가 자동으로 처리
		m.log.WithError(err).Warn("[Channel] ForceUpdate failed — watcher will handle")
	}

	return &DisputeResult{
		ChannelID: channelID,
		Nonce:     handle.latestNonce,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// GetChannelStatus — 채널 상태 조회
// ────────────────────────────────────────────────────────────────────
func (m *Manager) GetChannelStatus(channelID string) (*ChannelStatus, error) {
	handle, err := m.getHandle(channelID)
	if err != nil {
		return nil, err
	}

	handle.mu.Lock()
	defer handle.mu.Unlock()

	return &ChannelStatus{
		ChannelID:     channelID,
		Nonce:         handle.latestNonce,
		BalanceUser:   pricing.WeiToUsdc(handle.balanceUser),
		BalanceOp:     pricing.WeiToUsdc(handle.balanceOp),
		StateHash:     handle.latestStateHash,
		HoldDeadline:  handle.HoldDeadline,
	}, nil
}

// ────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ────────────────────────────────────────────────────────────────────

func (m *Manager) getHandle(channelID string) (*ChannelHandle, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	h, ok := m.channels[channelID]
	if !ok {
		return nil, fmt.Errorf("channel not found: %s", channelID)
	}
	return h, nil
}

func stateHash(s *channel.State) string {
	// go-perun의 state.ID()는 params 기반이므로 version 포함 해시 직접 계산
	return fmt.Sprintf("0x%x_%d", s.ID, s.Version)
}

func usdcToWei(usdc string) *big.Int {
	var f float64
	fmt.Sscanf(usdc, "%f", &f)
	bf := new(big.Float).SetPrec(128)
	bf.SetFloat64(f)
	multiplier := new(big.Float).SetPrec(128).SetInt64(1_000_000)
	bf.Mul(bf, multiplier)
	result, _ := bf.Int(nil)
	return result
}

// eventHandler — go-perun AdjudicatorEventHandler 구현
// ch.Watch(handler)에 전달됩니다.
type eventHandler struct {
	log       *logrus.Logger
	channelID channel.ID
}

func newEventHandler(log *logrus.Logger, id channel.ID) *eventHandler {
	return &eventHandler{log: log, channelID: id}
}

// HandleAdjudicatorEvent — 온체인 이벤트 처리
// go-perun이 분쟁, 정산 완료 등의 이벤트를 감지하면 이 함수를 호출합니다.
func (h *eventHandler) HandleAdjudicatorEvent(e channel.AdjudicatorEvent) {
	h.log.WithFields(logrus.Fields{
		"channel": fmt.Sprintf("%x", h.channelID),
		"event":   fmt.Sprintf("%T", e),
	}).Info("[Channel] on-chain event received")

	switch ev := e.(type) {
	case *channel.RegisteredEvent:
		h.log.WithField("version", ev.Version()).Info("[Channel] Registered — dispute detected, watcher will refute")
	case *channel.ConcludedEvent:
		h.log.Info("[Channel] Concluded — settlement complete")
	default:
		h.log.Infof("[Channel] unknown event type: %T", e)
	}
}

// ────────────────────────────────────────────────────────────────────
// 결과 타입들
// ────────────────────────────────────────────────────────────────────

type OpenChannelParams struct {
	SessionID    string
	UserAddress  string
	UserWireAddr map[wallet.BackendID]wire.Address
	DepositUsdc  string
	HoldDeadline int64
}

type UpdateRequest struct {
	ChannelID       string
	ServiceType     string
	DurationMinutes float64
	EnergyKwh       float64
}

type UpdateResult struct {
	NewNonce    uint64
	StateHash   string
	FareUsdc    string
	PolicyHash  string
	BalanceUser string
	BalanceOp   string
}

type FinalUpdateResult struct {
	FinalStateHash   string
	FinalNonce       uint64
	FinalBalanceUser string
	FinalBalanceOp   string
	TotalFareUsdc    string
}

type CloseResult struct {
	ChannelID    string
	FinalBalance string
	SettledAt    time.Time
}

type DisputeResult struct {
	ChannelID string
	Nonce     uint64
}

type ChannelStatus struct {
	ChannelID    string
	Nonce        uint64
	BalanceUser  string
	BalanceOp    string
	StateHash    string
	HoldDeadline int64
}
