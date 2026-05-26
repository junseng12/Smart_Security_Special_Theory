package refund

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
)

// MockTreasury — 개발용 mock (실제 구현: ethers.js walletService와 동일)
type MockTreasury struct {
	log *logrus.Logger
}

func NewMockTreasury(log *logrus.Logger) *MockTreasury {
	return &MockTreasury{log: log}
}

func (t *MockTreasury) SendUsdc(_ context.Context, toAddress, amountUsdc, reason string) (string, error) {
	txHash := fmt.Sprintf("0xmock_compensation_%s", uuid.New().String()[:8])
	t.log.WithFields(logrus.Fields{
		"to":     toAddress,
		"amount": amountUsdc,
		"reason": reason,
		"tx":     txHash,
	}).Info("[Treasury][MOCK] USDC sent")
	return txHash, nil
}
