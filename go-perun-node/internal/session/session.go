// Package session은 SmartCity 서비스 세션의 생명주기를 관리합니다.
// 세션은 "서비스 이용 단위"이며, Perun 채널과 1:1로 연결됩니다.
//
// startSession → openChannel → [proposeUsageUpdate × N] → finalUpdateAndAdjust → endSession
package session

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pkg/errors"
	"github.com/sirupsen/logrus"
)

// ────────────────────────────────────────────────────────────────────
// 타입 정의
// ────────────────────────────────────────────────────────────────────

// Status는 세션의 현재 단계를 나타냅니다.
type Status string

const (
	StatusActive    Status = "ACTIVE"     // 서비스 이용 중
	StatusEnded     Status = "ENDED"      // 세션 종료 요청됨
	StatusSettling  Status = "SETTLING"   // 온체인 정산 진행 중
	StatusSettled   Status = "SETTLED"    // 정산 완료
	StatusDisputed  Status = "DISPUTED"   // 분쟁 등록됨
)

// Session은 하나의 서비스 이용(예: 공유 자전거 1회)을 나타냅니다.
type Session struct {
	mu sync.RWMutex

	ID          string    `json:"session_id"`
	UserID      string    `json:"user_id"`
	UserAddress string    `json:"user_address"`
	ServiceID   string    `json:"service_id"`   // "bicycle" | "ev_charging" | "parking"
	ChannelID   string    `json:"channel_id"`
	DepositUsdc string    `json:"deposit_usdc"`
	ChargedUsdc string    `json:"charged_usdc"` // 누적 청구 (Perun balances.operator 기반)
	CreditUsdc  string    `json:"credit_usdc"`  // 누적 환불 credit (finalUpdate에 반영)
	Status      Status    `json:"status"`
	StartedAt   time.Time `json:"started_at"`
	EndedAt     *time.Time `json:"ended_at,omitempty"`
	HoldDeadline int64    `json:"hold_deadline"` // unix seconds
	EscrowID    string    `json:"escrow_id"`     // keccak256(sessionId)
}

// ────────────────────────────────────────────────────────────────────
// Manager: 세션 레지스트리 + 생명주기 함수들
// ────────────────────────────────────────────────────────────────────

// Manager는 모든 활성 세션을 메모리에 유지하고,
// DB 레이어(SessionStore)를 통해 영속화합니다.
type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session // sessionId → Session
	store    SessionStore
	log      *logrus.Logger
}

// SessionStore는 DB 인터페이스 (PostgreSQL 구현체가 주입됨)
type SessionStore interface {
	Save(ctx context.Context, s *Session) error
	Load(ctx context.Context, id string) (*Session, error)
	UpdateStatus(ctx context.Context, id string, status Status) error
	UpdateCharged(ctx context.Context, id string, chargedUsdc string) error
}

// NewManager는 Manager를 생성합니다.
func NewManager(store SessionStore, log *logrus.Logger) *Manager {
	return &Manager{
		sessions: make(map[string]*Session),
		store:    store,
		log:      log,
	}
}

// ────────────────────────────────────────────────────────────────────
// StartSession — 세션 생성
//
// go-perun 연동 포인트:
//   이 함수는 세션만 생성합니다.
//   채널 개설(Funder.Fund)은 channel.Manager.OpenChannel()이 담당.
//   두 함수는 channelOrchestrator에서 순서대로 호출됩니다.
// ────────────────────────────────────────────────────────────────────
func (m *Manager) StartSession(ctx context.Context, params StartParams) (*Session, error) {
	m.log.WithFields(logrus.Fields{
		"user":    params.UserAddress,
		"service": params.ServiceID,
		"deposit": params.DepositUsdc,
	}).Info("[Session] StartSession")

	s := &Session{
		ID:          uuid.New().String(),
		UserID:      params.UserID,
		UserAddress: params.UserAddress,
		ServiceID:   params.ServiceID,
		DepositUsdc: params.DepositUsdc,
		ChargedUsdc: "0",
		CreditUsdc:  "0",
		Status:      StatusActive,
		StartedAt:   time.Now(),
	}

	// DB 저장
	if err := m.store.Save(ctx, s); err != nil {
		return nil, errors.Wrap(err, "saving session to store")
	}

	// 메모리 등록
	m.mu.Lock()
	m.sessions[s.ID] = s
	m.mu.Unlock()

	m.log.WithField("session_id", s.ID).Info("[Session] created")
	return s, nil
}

// ────────────────────────────────────────────────────────────────────
// LinkChannel — 채널 ID를 세션에 연결
//
// go-perun: ProposeChannel 완료 후 channel.ID를 여기에 등록
// ────────────────────────────────────────────────────────────────────
func (m *Manager) LinkChannel(ctx context.Context, sessionID, channelID, escrowID string, holdDeadline int64) error {
	s := m.get(sessionID)
	if s == nil {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	s.mu.Lock()
	s.ChannelID    = channelID
	s.EscrowID     = escrowID
	s.HoldDeadline = holdDeadline
	s.mu.Unlock()

	return m.store.Save(ctx, s)
}

// ────────────────────────────────────────────────────────────────────
// EndSession — 세션 종료 트리거
//
// go-perun 연동 포인트:
//   이 함수 호출 전에 반드시:
//     1) FinalUpdateAndAdjust() — 마지막 요금 + credit 반영
//     2) channel.Manager.CloseChannel() — ch.Settle() 호출
//   이 두 함수는 channelOrchestrator.EndSessionAndSettle()에서 조율됩니다.
// ────────────────────────────────────────────────────────────────────
func (m *Manager) EndSession(ctx context.Context, sessionID string) error {
	s := m.get(sessionID)
	if s == nil {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	s.mu.Lock()
	now := time.Now()
	s.Status  = StatusEnded
	s.EndedAt = &now
	s.mu.Unlock()

	return m.store.UpdateStatus(ctx, sessionID, StatusEnded)
}

// MarkSettling — 온체인 정산 시작
func (m *Manager) MarkSettling(ctx context.Context, sessionID string) error {
	return m.updateStatus(ctx, sessionID, StatusSettling)
}

// MarkSettled — 정산 완료
func (m *Manager) MarkSettled(ctx context.Context, sessionID string) error {
	return m.updateStatus(ctx, sessionID, StatusSettled)
}

// AccumulateCharge — Perun 오프체인 update마다 charged_usdc 누적
//
// go-perun: ch.Update() 성공 후 호출.
// balances.operator 증가분이 이 값과 일치해야 합니다.
func (m *Manager) AccumulateCharge(ctx context.Context, sessionID, deltaUsdc string) error {
	s := m.get(sessionID)
	if s == nil {
		return fmt.Errorf("session not found: %s", sessionID)
	}

	s.mu.Lock()
	// string arithmetic — production에서는 big.Float 사용 권장
	s.ChargedUsdc = addUsdc(s.ChargedUsdc, deltaUsdc)
	charged := s.ChargedUsdc
	s.mu.Unlock()

	m.log.WithFields(logrus.Fields{
		"session_id":   sessionID,
		"delta":        deltaUsdc,
		"total_charged": charged,
	}).Debug("[Session] charge accumulated")

	return m.store.UpdateCharged(ctx, sessionID, charged)
}

// Get — 세션 조회
func (m *Manager) Get(sessionID string) (*Session, error) {
	s := m.get(sessionID)
	if s == nil {
		return nil, fmt.Errorf("session not found: %s", sessionID)
	}
	return s, nil
}

// ────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ────────────────────────────────────────────────────────────────────

func (m *Manager) get(id string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[id]
}

func (m *Manager) updateStatus(ctx context.Context, id string, status Status) error {
	s := m.get(id)
	if s == nil {
		return fmt.Errorf("session not found: %s", id)
	}
	s.mu.Lock()
	s.Status = status
	s.mu.Unlock()
	return m.store.UpdateStatus(ctx, id, status)
}

// addUsdc는 두 USDC 문자열을 덧셈합니다 (간단 버전).
func addUsdc(a, b string) string {
	var fa, fb float64
	fmt.Sscanf(a, "%f", &fa)
	fmt.Sscanf(b, "%f", &fb)
	return fmt.Sprintf("%.6f", fa+fb)
}

// ────────────────────────────────────────────────────────────────────
// StartParams
// ────────────────────────────────────────────────────────────────────

type StartParams struct {
	UserID      string
	UserAddress string
	ServiceID   string
	DepositUsdc string
}
