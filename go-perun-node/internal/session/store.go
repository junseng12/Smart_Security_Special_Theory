package session

import (
	"context"
	"fmt"
	"sync"
)

// InMemoryStore — 개발/테스트용 인메모리 SessionStore
type InMemoryStore struct {
	mu       sync.RWMutex
	sessions map[string]*Session
}

func NewInMemoryStore() *InMemoryStore {
	return &InMemoryStore{sessions: make(map[string]*Session)}
}

func (s *InMemoryStore) Save(_ context.Context, sess *Session) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	// 깊은 복사
	copy := *sess
	s.sessions[sess.ID] = &copy
	return nil
}

func (s *InMemoryStore) Load(_ context.Context, id string) (*Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sess, ok := s.sessions[id]
	if !ok {
		return nil, fmt.Errorf("session not found: %s", id)
	}
	copy := *sess
	return &copy, nil
}

func (s *InMemoryStore) UpdateStatus(_ context.Context, id string, status Status) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return fmt.Errorf("session not found: %s", id)
	}
	sess.Status = status
	return nil
}

func (s *InMemoryStore) UpdateCharged(_ context.Context, id string, charged string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[id]
	if !ok {
		return fmt.Errorf("session not found: %s", id)
	}
	sess.ChargedUsdc = charged
	return nil
}
