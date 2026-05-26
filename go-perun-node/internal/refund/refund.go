package refund

import (
	"context"
	"fmt"
	"sync"

	"github.com/sirupsen/logrus"
)

type Manager struct {
	mu      sync.RWMutex
	credits map[string]float64 // channelID → 누적 credit USDC
	log     *logrus.Logger
}

func NewManager(log *logrus.Logger) *Manager {
	return &Manager{credits: make(map[string]float64), log: log}
}

func (m *Manager) Accumulate(channelID, deltaUsdc, reason string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var d float64
	fmt.Sscanf(deltaUsdc, "%f", &d)
	m.credits[channelID] += d
	total := fmt.Sprintf("%.6f", m.credits[channelID])
	m.log.WithFields(logrus.Fields{"channel": channelID, "delta": deltaUsdc, "total": total, "reason": reason}).
		Info("[Refund] credit accumulated")
	return total, nil
}

func (m *Manager) GetTotal(channelID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return fmt.Sprintf("%.6f", m.credits[channelID])
}

type Treasury interface {
	SendUsdc(ctx context.Context, to, amount, reason string) (string, error)
}

func PostSettlement(ctx context.Context, t Treasury, to, amount, reason string, log *logrus.Logger) (string, error) {
	tx, err := t.SendUsdc(ctx, to, amount, reason)
	if err != nil {
		return "", fmt.Errorf("treasury send failed: %w", err)
	}
	log.WithFields(logrus.Fields{"tx": tx, "to": to, "amount": amount}).Info("[Refund] post-settlement compensation sent")
	return tx, nil
}
