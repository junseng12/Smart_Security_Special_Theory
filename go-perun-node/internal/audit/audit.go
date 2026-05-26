// Package audit는 모든 결제/환불/정산 이벤트를 감사 로그로 저장합니다.
// 공공 서비스 특성상 "왜 이렇게 됐는지" 증빙이 가능해야 합니다.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
)

type Action string

const (
	ActionSessionStart      Action = "SESSION_START"
	ActionChannelOpen       Action = "CHANNEL_OPEN"
	ActionUsageCharge       Action = "USAGE_CHARGE"      // Perun ch.Update()
	ActionFinalUpdate       Action = "FINAL_UPDATE"       // IsFinal=true
	ActionChannelSettle     Action = "CHANNEL_SETTLE"     // ch.Settle()
	ActionDisputeInitiated  Action = "DISPUTE_INITIATED"
	ActionCreditAccumulated Action = "CREDIT_ACCUMULATED"
	ActionCompensationSent  Action = "COMPENSATION_SENT"
)

type LogEntry struct {
	ID        string    `json:"id"`
	Action    Action    `json:"action"`
	ChannelID string    `json:"channel_id,omitempty"`
	SessionID string    `json:"session_id,omitempty"`
	Metadata  string    `json:"metadata"` // JSON
	CreatedAt time.Time `json:"created_at"`
}

type Logger struct {
	mu      sync.Mutex
	entries []*LogEntry // 메모리 버퍼 (DB 저장 전 캐시)
	store   AuditStore
	log     *logrus.Logger
}

type AuditStore interface {
	Save(ctx context.Context, entry *LogEntry) error
}

func NewLogger(store AuditStore, log *logrus.Logger) *Logger {
	return &Logger{store: store, log: log}
}

// Log는 감사 로그를 저장합니다.
// go-perun의 각 주요 동작(Update, Settle, Dispute 등) 후 호출됩니다.
func (l *Logger) Log(ctx context.Context, action Action, channelID, sessionID string, meta interface{}) (string, error) {
	metaBytes, _ := json.Marshal(meta)

	entry := &LogEntry{
		ID:        uuid.New().String(),
		Action:    action,
		ChannelID: channelID,
		SessionID: sessionID,
		Metadata:  string(metaBytes),
		CreatedAt: time.Now(),
	}

	l.mu.Lock()
	l.entries = append(l.entries, entry)
	l.mu.Unlock()

	if err := l.store.Save(ctx, entry); err != nil {
		l.log.WithError(err).Warn("[Audit] DB save failed — entry buffered in memory")
	}

	l.log.WithFields(logrus.Fields{
		"action":     action,
		"channel_id": channelID,
		"session_id": sessionID,
		"log_id":     entry.ID,
	}).Info("[Audit] logged")

	return entry.ID, nil
}

// EmitEvent — SSE/WebSocket으로 프론트엔드에 이벤트 전송
// Node.js sseClients와 동일한 역할을 gRPC StreamEvents로 구현합니다.
func (l *Logger) EmitEvent(eventType, channelID, sessionID string, payload interface{}) {
	payloadBytes, _ := json.Marshal(payload)
	l.log.WithFields(logrus.Fields{
		"event":      eventType,
		"channel_id": channelID,
		"session_id": sessionID,
		"payload":    fmt.Sprintf("%.80s...", string(payloadBytes)),
	}).Info("[Event] emitted")

	// TODO: gRPC stream으로 구독자에게 push
}
