package audit

import (
	"context"
	"sync"
)

// InMemoryStore — 개발용 감사 로그 인메모리 저장
type InMemoryStore struct {
	mu      sync.Mutex
	entries []*LogEntry
}

func NewInMemoryStore() *InMemoryStore {
	return &InMemoryStore{}
}

func (s *InMemoryStore) Save(_ context.Context, entry *LogEntry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = append(s.entries, entry)
	return nil
}
