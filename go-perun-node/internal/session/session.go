// Package session: 서비스 이용 단위(세션) 생명주기 관리
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

type Status string
const (
	StatusActive   Status = "ACTIVE"
	StatusEnded    Status = "ENDED"
	StatusSettling Status = "SETTLING"
	StatusSettled  Status = "SETTLED"
)

type Session struct {
	mu sync.RWMutex
	ID           string
	UserAddress  string
	ServiceID    string
	ChannelID    string
	DepositUsdc  string
	ChargedUsdc  string
	CreditUsdc   string
	Status       Status
	StartedAt    time.Time
	EndedAt      *time.Time
	HoldDeadline int64
	EscrowID     string
}

type Manager struct {
	mu       sync.RWMutex
	sessions map[string]*Session
	log      *logrus.Logger
}

func NewManager(log *logrus.Logger) *Manager {
	return &Manager{sessions: make(map[string]*Session), log: log}
}

func (m *Manager) Start(ctx context.Context, userAddress, serviceID, depositUsdc string) (*Session, error) {
	s := &Session{
		ID:          uuid.New().String(),
		UserAddress: userAddress,
		ServiceID:   serviceID,
		DepositUsdc: depositUsdc,
		ChargedUsdc: "0",
		CreditUsdc:  "0",
		Status:      StatusActive,
		StartedAt:   time.Now(),
	}
	m.mu.Lock()
	m.sessions[s.ID] = s
	m.mu.Unlock()
	m.log.WithField("session_id", s.ID).Info("[Session] started")
	return s, nil
}

func (m *Manager) LinkChannel(sessionID, channelID, escrowID string, holdDeadline int64) error {
	s := m.get(sessionID)
	if s == nil {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	s.mu.Lock()
	s.ChannelID    = channelID
	s.EscrowID     = escrowID
	s.HoldDeadline = holdDeadline
	s.mu.Unlock()
	return nil
}

func (m *Manager) AccumulateCharge(sessionID, deltaUsdc string) error {
	s := m.get(sessionID)
	if s == nil {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	s.mu.Lock()
	s.ChargedUsdc = addUsdc(s.ChargedUsdc, deltaUsdc)
	s.mu.Unlock()
	return nil
}

func (m *Manager) End(sessionID string) error {
	s := m.get(sessionID)
	if s == nil {
		return fmt.Errorf("session not found: %s", sessionID)
	}
	s.mu.Lock()
	now := time.Now()
	s.Status  = StatusEnded
	s.EndedAt = &now
	s.mu.Unlock()
	return nil
}

func (m *Manager) SetStatus(sessionID string, status Status) error {
	s := m.get(sessionID)
	if s == nil {
		return errors.Errorf("session not found: %s", sessionID)
	}
	s.mu.Lock()
	s.Status = status
	s.mu.Unlock()
	return nil
}

func (m *Manager) Get(sessionID string) (*Session, error) {
	s := m.get(sessionID)
	if s == nil {
		return nil, fmt.Errorf("session not found: %s", sessionID)
	}
	return s, nil
}

func (m *Manager) get(id string) *Session {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.sessions[id]
}

func addUsdc(a, b string) string {
	var fa, fb float64
	fmt.Sscanf(a, "%f", &fa)
	fmt.Sscanf(b, "%f", &fb)
	return fmt.Sprintf("%.6f", fa+fb)
}
