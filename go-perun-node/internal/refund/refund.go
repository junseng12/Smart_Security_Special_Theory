// Package refund는 두 종류의 환불을 처리합니다:
//
//  1. 정산 전 환불 (Pre-settle Credit):
//     accumulateRefundCredit() → credit 누적
//     → finalUpdateAndAdjust()에서 Perun 상태에 반영
//     → IsFinal=true 상태로 양측 서명 → ch.Settle()
//
//  2. 정산 후 환불 (Post-settle Compensation):
//     채널이 이미 닫힌 뒤 → Perun 채널로 되돌릴 수 없음
//     → 운영자 Treasury 지갑에서 직접 USDC 송금
package refund

import (
	"context"
	"fmt"
	"sync"

	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
)

// ────────────────────────────────────────────────────────────────────
// CreditStore — 정산 전 credit 누적 저장소
// ────────────────────────────────────────────────────────────────────

type CreditRecord struct {
	ChannelID   string
	TotalCredit string // USDC 누적합
	Entries     []CreditEntry
}

type CreditEntry struct {
	ID       string
	Delta    string // USDC
	Reason   string
}

// Manager는 credit 누적과 정산 후 보상을 처리합니다.
type Manager struct {
	mu      sync.RWMutex
	credits map[string]*CreditRecord // channelId → CreditRecord

	// Treasury는 정산 후 환불용 지갑 서비스 인터페이스
	treasury TreasuryService
	log      *logrus.Logger
}

// TreasuryService는 운영자 지갑에서 USDC를 송금하는 인터페이스입니다.
// (ethers.js 기반 walletService와 동일한 역할을 Go에서 담당)
type TreasuryService interface {
	SendUsdc(ctx context.Context, toAddress, amountUsdc, reason string) (txHash string, err error)
}

func NewManager(treasury TreasuryService, log *logrus.Logger) *Manager {
	return &Manager{
		credits:  make(map[string]*CreditRecord),
		treasury: treasury,
		log:      log,
	}
}

// ────────────────────────────────────────────────────────────────────
// AccumulateRefundCredit — 정산 전 환불 credit 누적
//
// go-perun 연동 포인트:
//   이 함수는 credit을 메모리에만 누적합니다.
//   실제 Perun 채널 상태는 변경하지 않습니다.
//   FinalUpdateAndAdjust()에서 이 값을 가져와
//   ch.Update(ctx, func(state){ TransferBalance(operator→user, creditWei) })
//   로 한 번에 반영합니다.
//
//   이유: Perun update를 매번 보내면 nonce 충돌 가능 + UX 복잡해짐.
//   "종료 직전 1회 반영" 패턴으로 업데이트 폭증을 방지합니다.
// ────────────────────────────────────────────────────────────────────
func (m *Manager) AccumulateRefundCredit(ctx context.Context, channelID, deltaUsdc, reason string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	rec, ok := m.credits[channelID]
	if !ok {
		rec = &CreditRecord{ChannelID: channelID, TotalCredit: "0"}
		m.credits[channelID] = rec
	}

	// 누적
	rec.TotalCredit = addUsdc(rec.TotalCredit, deltaUsdc)
	rec.Entries = append(rec.Entries, CreditEntry{
		ID:     uuid.New().String(),
		Delta:  deltaUsdc,
		Reason: reason,
	})

	m.log.WithFields(logrus.Fields{
		"channel_id":   channelID,
		"delta_usdc":   deltaUsdc,
		"total_credit": rec.TotalCredit,
		"reason":       reason,
	}).Info("[Refund] credit accumulated")

	return rec.TotalCredit, nil
}

// GetTotalCredit — 채널의 누적 credit 조회
// (FinalUpdateAndAdjust에서 호출)
func (m *Manager) GetTotalCredit(channelID string) string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if rec, ok := m.credits[channelID]; ok {
		return rec.TotalCredit
	}
	return "0"
}

// ────────────────────────────────────────────────────────────────────
// PostSettlementCompensation — 정산 후 환불 (Treasury 송금)
//
// go-perun 연동 포인트:
//   채널이 이미 ch.Settle() 완료된 경우 사용합니다.
//   Perun 채널 상태와 무관하게 operator 지갑 → user 지갑으로 직접 송금.
//
//   MVP: 관리자 승인 후 단순 USDC transfer
//   고도화: Merkle claim 방식 (batch compensation)
// ────────────────────────────────────────────────────────────────────
func (m *Manager) PostSettlementCompensation(ctx context.Context, userAddress, amountUsdc, reason string) (string, error) {
	m.log.WithFields(logrus.Fields{
		"user":   userAddress,
		"amount": amountUsdc,
		"reason": reason,
	}).Info("[Refund] PostSettlementCompensation")

	txHash, err := m.treasury.SendUsdc(ctx, userAddress, amountUsdc, reason)
	if err != nil {
		return "", fmt.Errorf("treasury send failed: %w", err)
	}

	m.log.WithFields(logrus.Fields{
		"tx_hash": txHash,
		"user":    userAddress,
		"amount":  amountUsdc,
	}).Info("[Refund] compensation sent")

	return txHash, nil
}

// 헬퍼
func addUsdc(a, b string) string {
	var fa, fb float64
	fmt.Sscanf(a, "%f", &fa)
	fmt.Sscanf(b, "%f", &fb)
	return fmt.Sprintf("%.6f", fa+fb)
}
