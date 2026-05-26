package audit

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
)

type Action string
const (
	ActionChannelOpen    Action = "CHANNEL_OPEN"
	ActionUsageCharge    Action = "USAGE_CHARGE"
	ActionFinalUpdate    Action = "FINAL_UPDATE"
	ActionSettle         Action = "CHANNEL_SETTLE"
	ActionDispute        Action = "DISPUTE_INITIATED"
	ActionCreditAccum    Action = "CREDIT_ACCUMULATED"
	ActionCompensation   Action = "COMPENSATION_SENT"
)

type Entry struct {
	ID        string
	Action    Action
	ChannelID string
	SessionID string
	Meta      string
	At        time.Time
}

type Logger struct {
	mu      sync.Mutex
	entries []*Entry
	log     *logrus.Logger
}

func NewLogger(log *logrus.Logger) *Logger { return &Logger{log: log} }

func (l *Logger) Log(_ context.Context, action Action, channelID, sessionID string, meta interface{}) string {
	b, _ := json.Marshal(meta)
	e := &Entry{ID: uuid.New().String(), Action: action, ChannelID: channelID, SessionID: sessionID, Meta: string(b), At: time.Now()}
	l.mu.Lock()
	l.entries = append(l.entries, e)
	l.mu.Unlock()
	l.log.WithFields(logrus.Fields{"action": action, "channel": channelID, "session": sessionID}).Info("[Audit]")
	return e.ID
}
