/**
 * ScanPay.jsx — Perun 마이크로 페이먼트 결제 페이지
 *
 * 전체 흐름:
 *   1. 서비스 선택 → 백엔드 세션 생성 (escrowId, holdDeadline 수령)
 *   2. MetaMask: USDC approve → userDeposit(컨트랙트)
 *   3. 백엔드 /deposit → operatorDeposit 자동 처리 → FullyFunded
 *   4. [ACTIVE] 60초마다 자동 /charge (Perun off-chain 상태 업데이트)
 *      → channelState.balances.operator 누적 (예: 3분 = 0.03 USDC)
 *   5. 종료 → /end → settleAndRelease(fareUsdc=누적요금)
 *      → 컨트랙트: operator에 0.03, user에 2.97 즉시 환불
 */

import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, AlertCircle, ArrowLeft, Loader2, Lock, Zap, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BottomNav from '@/components/wallet/BottomNav';
import { approveUsdc, callUserDeposit, waitForTx, personalSign, getUsdcBalance } from '@/lib/walletUtils';

const BACKEND  = "https://smartcity-payment-backend-production.up.railway.app";
const ESCROW_V3 = "0xb6094337a6F37306eBDadd9923991275Cc6220f7";
const OPERATOR  = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";

// ★ Perun 마이크로 페이먼트: 60초마다 /charge 자동 호출
const MICRO_PAYMENT_INTERVAL_MS = 60_000;

// ─── API 헬퍼 ────────────────────────────────────────────────────────────────
async function apiCall(path, method = "GET", body = null) {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false)
    throw new Error(data.errors?.[0] || data.error || "API Error");
  return data.data ?? data;
}

// ─── 서비스 목록 ──────────────────────────────────────────────────────────────
const SERVICE_TYPES = [
  {
    id: "parking", label: "주차", emoji: "🚗",
    serviceId: "PARKING-LOT-A-001",
    rate: "0.02 USDC/min", rateNum: 0.02,
    depositUsdc: 5.0,
  },
  {
    id: "bicycle", label: "공유 자전거", emoji: "🚴",
    serviceId: "BIKE-STATION-007",
    rate: "0.01 USDC/min", rateNum: 0.01,
    depositUsdc: 3.0,
  },
  {
    id: "ev_charging", label: "전기차 충전", emoji: "⚡",
    serviceId: "EV-CHARGER-B-003",
    rate: "0.25 USDC/kWh", rateNum: 0.25,
    depositUsdc: 10.0,
  },
];

// ─── 세션 persist (localStorage) ──────────────────────────────────────────────
const SESSION_KEY = "active_session";
const saveSession  = (service, sessionData, startedAt, depositTxHash) =>
  localStorage.setItem(SESSION_KEY, JSON.stringify({ service, sessionData, startedAt, depositTxHash }));
const clearSession = () => localStorage.removeItem(SESSION_KEY);
const loadSession  = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } };

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
export default function ScanPay() {
  const navigate     = useNavigate();
  const queryClient  = useQueryClient();

  // ── UI 상태 ──
  const [step, setStep]           = useState("select");   // select | scanning | active | ended
  const [selectedService, setSvc] = useState(null);
  const [sessionData, setSession] = useState(null);
  const [elapsed, setElapsed]     = useState(0);
  const [log, setLog]             = useState([]);
  const [error, setError]         = useState(null);
  const [ending, setEnding]       = useState(false);

  // ── Perun 채널 상태 ──
  const [channelState, setChannelState]         = useState(null);  // { nonce, balances }
  const [totalChargedUsdc, setTotalCharged]     = useState(0);     // 누적 요금 (표시용)
  const [settlementResult, setSettlementResult] = useState(null);  // 최종 정산 결과

  // ── refs (클로저 문제 방지) ──
  const timerRef      = useRef(null);
  const microPayRef   = useRef(null);
  const startedAtRef  = useRef(null);
  const sessionRef    = useRef(null);
  const serviceRef    = useRef(null);
  const mmAddrRef     = useRef(null);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet    = wallets[0];
  const mmAddress = localStorage.getItem("mm_address");
  useEffect(() => { mmAddrRef.current = mmAddress; }, [mmAddress]);

  // ── 세션 복원 ──
  useEffect(() => {
    const saved = loadSession();
    if (saved?.sessionData && saved?.service) {
      startedAtRef.current = saved.startedAt;
      sessionRef.current   = saved.sessionData;
      serviceRef.current   = saved.service;
      setSvc(saved.service);
      setSession(saved.sessionData);
      setElapsed(Math.floor((Date.now() - saved.startedAt) / 1000));
      setStep("active");
      addLog("⚠️ 세션 복원됨 — 종료 버튼을 눌러 정산하세요", "error");
    }
  }, []);

  // ── 1초 타이머 ──
  useEffect(() => {
    if (step === "active") {
      timerRef.current = setInterval(() => {
        setElapsed(startedAtRef.current
          ? Math.floor((Date.now() - startedAtRef.current) / 1000)
          : e => e + 1);
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [step]);

  // ── ★ Perun 마이크로 페이먼트 (60초 자동 charge) ──
  useEffect(() => {
    if (step !== "active") {
      clearInterval(microPayRef.current);
      return;
    }

    microPayRef.current = setInterval(async () => {
      const sd   = sessionRef.current;
      const svc  = serviceRef.current;
      const addr = mmAddrRef.current;
      if (!sd || !svc || !addr) return;

      try {
        // 1분 증분 charge → Perun off-chain state update
        const res = await apiCall(`/api/v1/sessions/${sd.sessionId}/charge`, "POST", {
          channelId:   sd.channelId,
          userAddress: addr,
          serviceType: svc.id,
          usage: { durationMinutes: 1 },   // ★ 1분 증분
        });

        const updated = res.updatedState;
        if (updated) {
          setChannelState(updated);
          // operator 잔액 = 누적 요금 (wei → USDC, 6 decimals)
          const accUsdc = Number(BigInt(updated.balances?.operator || '0')) / 1_000_000;
          setTotalCharged(accUsdc);
        }
        addLog(
          `⚡ 마이크로 차감 +${res.fare?.fareUsdc} USDC | 누적 ${(Number(BigInt(res.updatedState?.balances?.operator||'0'))/1e6).toFixed(4)} | nonce #${res.updatedState?.nonce}`,
          "info"
        );
      } catch (e) {
        addLog(`⚠️ 마이크로 페이먼트 오류 (무시): ${e.message}`, "error");
      }
    }, MICRO_PAYMENT_INTERVAL_MS);

    return () => clearInterval(microPayRef.current);
  }, [step]);

  const addLog = (msg, type = "info") =>
    setLog(prev => [...prev, { msg, type, ts: new Date().toLocaleTimeString() }]);

  const fmt = (s) =>
    `${String(Math.floor(s / 60)).padStart(2,"0")}:${String(s % 60).padStart(2,"0")}`;

  // ─────────────────────────────────────────────────────────────────────────
  // startSession
  // ─────────────────────────────────────────────────────────────────────────
  const startSession = async (service) => {
    const existing = loadSession();
    if (existing?.sessionData) {
      setError(`이미 진행 중인 세션(${existing.service?.emoji} ${existing.service?.label})이 있습니다. 먼저 종료해주세요.`);
      return;
    }

    setSvc(service);
    serviceRef.current = service;
    setStep("scanning");
    setError(null);
    setLog([]);
    addLog(`QR 스캔: ${service.serviceId}`, "info");

    try {
      // 1. 백엔드 세션 생성
      addLog("🔧 세션 생성 중...", "info");
      const data = await apiCall("/api/v1/sessions/start", "POST", {
        userAddress:  mmAddress,
        serviceType:  service.id,
        depositUsdc:  String(service.depositUsdc),
      });
      addLog(`✅ 세션 생성 — ${data.sessionId?.slice(0,14)}...`, "success");

      const { escrowId, holdDeadline } = data;

      // 2. USDC approve
      addLog(`💳 MetaMask — USDC approve (${service.depositUsdc} USDC)...`, "info");
      const approveTx = await approveUsdc(mmAddress, service.depositUsdc);
      await waitForTx(approveTx);
      addLog(`✅ approve 완료`, "success");

      // 3. userDeposit 컨트랙트 호출
      addLog(`💳 MetaMask — userDeposit 컨트랙트 호출...`, "info");
      const depositTx = await callUserDeposit(mmAddress, escrowId, service.depositUsdc, holdDeadline);
      await waitForTx(depositTx);
      addLog(`✅ 온체인 예치 완료 — ${depositTx.slice(0,18)}...`, "success");

      // 4. 백엔드 deposit 기록 → operatorDeposit 자동 트리거
      await apiCall(`/api/v1/sessions/${data.sessionId}/deposit`, "POST", {
        channelId:     data.channelId,
        userAddress:   mmAddress,
        depositUsdc:   String(service.depositUsdc),
        holdDeadline,
        depositTxHash: depositTx,
      });
      addLog(`✅ operator 보증금 자동 처리 완료 (FullyFunded)`, "success");

      // 5. 세션 활성화
      const now = Date.now();
      startedAtRef.current = now;
      sessionRef.current   = data;
      setSession(data);
      setChannelState(data.initialState || null);
      setTotalCharged(0);
      saveSession(service, data, now, depositTx);
      setStep("active");
      addLog(`🟢 서비스 이용 시작! 60초마다 자동 요금 차감`, "success");

      // 6. DB 기록 & 잔액 갱신
      await base44.entities.Transaction.create({
        type: 'session_start', amount: service.depositUsdc, status: 'active',
        to_address: ESCROW_V3, from_address: mmAddress,
        merchant_name: `${service.emoji} ${service.label}`, tx_hash: depositTx,
        wallet_id: wallet?.id, note: `세션: ${data.sessionId}`,
      }).catch(() => {});
      const newBal = await getUsdcBalance(mmAddress);
      localStorage.setItem("mm_balance", newBal);
      if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: newBal }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['wallets'] });

    } catch (e) {
      setError(e.message);
      setStep("select");
      addLog(`❌ 실패: ${e.message}`, "error");
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // endSession — Perun 정산
  //
  // 핵심 원칙:
  //   fareUsdc = finalState.balances.operator  (60초 누적합, wei→USDC)
  //   컨트랙트 settleAndRelease(escrowId, fareWei):
  //     → operator에게 fare USDC 지급
  //     → user에게 (deposit - fare) USDC 즉시 환불
  //     → operator보증금 반환
  // ─────────────────────────────────────────────────────────────────────────
  const endSession = async () => {
    if (ending) return;
    setEnding(true);
    clearInterval(microPayRef.current);   // 마이크로 페이먼트 즉시 정지

    const sd  = sessionRef.current;
    const svc = serviceRef.current;
    const addr = mmAddrRef.current;

    // ── 잔여 시간 마지막 charge ──────────────────────────────────────────────
    let finalState = channelState;
    let finalFareUsdc = totalChargedUsdc;

    try {
      const elapsedMin   = elapsed / 60;
      const lastInterval = elapsedMin % 1;
      const remainder    = lastInterval > 0.01 ? lastInterval : 0;

      addLog(`⚡ 잔여 ${(remainder * 60).toFixed(0)}초 최종 정산 중...`, "info");
      const lastCharge = await apiCall(`/api/v1/sessions/${sd.sessionId}/charge`, "POST", {
        channelId: sd.channelId, userAddress: addr,
        serviceType: svc.id,
        usage: { durationMinutes: remainder },
      });

      finalState = lastCharge.updatedState || finalState;
      if (finalState?.balances?.operator) {
        // ★ operator 잔액 = 60초 인터벌 누적 + 잔여 시간 = 최종 요금
        finalFareUsdc = Number(BigInt(finalState.balances.operator)) / 1_000_000;
        setTotalCharged(finalFareUsdc);
      }
      addLog(`💰 최종 누적 요금: ${finalFareUsdc.toFixed(6)} USDC (nonce #${finalState?.nonce})`, "success");
    } catch (e) {
      addLog(`⚠️ 잔여 charge 실패 (누적값 사용): ${e.message}`, "error");
    }

    // ── MetaMask personal_sign (최종 상태 서명) ──────────────────────────────
    let userFinalSig = "0xmock_fallback";
    try {
      if (window.ethereum && finalState) {
        // 0분 charge → stateHash만 획득 (요금 추가 없음)
        const sigRes = await apiCall(`/api/v1/sessions/${sd.sessionId}/charge`, "POST", {
          channelId: sd.channelId, userAddress: addr,
          serviceType: svc.id, usage: { durationMinutes: 0 },
        });
        const stateHash = sigRes?.signatureRequest?.stateHash;
        if (stateHash) {
          userFinalSig = await personalSign(addr, stateHash);
          addLog(`✅ MetaMask 서명 완료`, "success");
        }
      }
    } catch (sigErr) {
      addLog(`⚠️ 서명 실패 → mock 사용: ${sigErr.message}`, "error");
    }

    // ── /end 호출 — fareUsdc 생략 → 백엔드가 finalState.balances.operator 사용 ──
    let result = null;
    try {
      addLog(`🔒 정산 요청 중...`, "info");
      result = await apiCall(`/api/v1/sessions/${sd.sessionId}/end`, "POST", {
        channelId:    sd.channelId,
        userAddress:  addr,
        userFinalSig,
        // fareUsdc 생략 ★ → 백엔드가 finalState.balances.operator (Perun 누적) 사용
      });

      const esc = result?.escrow || {};
      const fare   = esc.fareUsdc   ?? finalFareUsdc.toFixed(6);
      const refund = esc.refundUsdc ?? (selectedService?.depositUsdc - finalFareUsdc).toFixed(6);
      const txHash = esc.txHash;

      setSettlementResult({ fare, refund, txHash, deferred: esc.deferred });

      if (txHash) {
        addLog(`✅ 온체인 정산 완료! TX: ${txHash.slice(0,18)}...`, "success");
        addLog(`💚 ${refund} USDC → 내 지갑 즉시 환불`, "success");
        addLog(`🏦 ${fare} USDC → operator (요금)`, "info");
      } else if (esc.deferred) {
        addLog(`⏳ holdDeadline 대기 중 → 자동 정산 예약됨`, "info");
        addLog(`💚 환불 예정: ${refund} USDC → 내 지갑`, "success");
      } else {
        addLog(`ℹ️ 정산 처리됨 (fare: ${fare} USDC)`, "info");
      }
    } catch (e) {
      addLog(`⚠️ /end 오류: ${e.message}`, "error");
      // fallback: 로컬 계산값
      setSettlementResult({
        fare:   finalFareUsdc.toFixed(6),
        refund: (svc?.depositUsdc - finalFareUsdc).toFixed(6),
        txHash: null,
      });
    }

    // ── DB 기록 ──────────────────────────────────────────────────────────────
    try {
      await base44.entities.Transaction.create({
        type: 'payment', amount: finalFareUsdc, status: 'completed',
        to_address: svc.serviceId, from_address: addr,
        merchant_name: `${svc.emoji} ${svc.label}`,
        tx_hash: result?.escrow?.txHash || sd.sessionId,
        wallet_id: wallet?.id,
        note: `이용시간: ${fmt(elapsed)} / 요금: ${finalFareUsdc.toFixed(6)} USDC / 환불: ${result?.escrow?.refundUsdc ?? '처리중'} USDC`,
      }).catch(() => {});
    } catch (e) {
      addLog(`⚠️ DB 기록 오류: ${e.message}`, "error");
    }

    clearSession();
    setEnding(false);
    setStep("ended");

    // ── ★ settle 완료 polling (deferred 케이스 대응) ──────────────────────────
    // /end가 deferred(holdDeadline 대기중)이면 주기적으로 온체인 확인
    // → Released 상태 되면 MetaMask 잔액 갱신
    if (result?.escrow?.deferred || !result?.escrow?.txHash) {
      addLog("⏳ 온체인 정산 대기 중... 자동으로 확인합니다", "info");
      let pollCount = 0;
      const maxPoll = 24; // 최대 2분 (5초 × 24)
      const pollId = setInterval(async () => {
        pollCount++;
        if (pollCount > maxPoll) {
          clearInterval(pollId);
          addLog("⚠️ 정산 확인 시간 초과 — BaseScan에서 직접 확인하세요", "error");
          return;
        }
        try {
          const status = await apiCall(`/api/v1/sessions/${sd.sessionId}/escrow-status`);
          if (status.settled || status.onchain?.state === 'Released') {
            clearInterval(pollId);
            addLog(`✅ 온체인 정산 완료! TX: ${status.settleTx?.slice(0,18) || '확인됨'}...`, "success");
            addLog(`💚 ${status.refundUsdc} USDC → 내 지갑 환불 완료`, "success");
            // 설정 결과 업데이트
            setSettlementResult(prev => ({
              ...prev,
              txHash: status.settleTx,
              refund: status.refundUsdc,
            }));
            // 온체인 실잔액 반영
            const newBal = await getUsdcBalance(addr);
            localStorage.setItem("mm_balance", newBal);
            if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: newBal }).catch(() => {});
            queryClient.invalidateQueries({ queryKey: ['wallets'] });
            queryClient.invalidateQueries({ queryKey: ['transactions'] });
          } else {
            addLog(`🔄 정산 확인 중... (${pollCount}/${maxPoll}) 상태: ${status.onchain?.state || status.dbState}`, "info");
          }
        } catch(e) {
          // poll 오류는 무시
        }
      }, 5000);
    } else {
      // 즉시 정산된 경우 — 잔액만 갱신
      try {
        const newBal = await getUsdcBalance(addr);
        localStorage.setItem("mm_balance", newBal);
        if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: newBal }).catch(() => {});
        queryClient.invalidateQueries({ queryKey: ['wallets'] });
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
      } catch(e) {}
    }
  };

  // ── 초기화 ──
  const reset = () => {
    clearSession();
    clearInterval(microPayRef.current);
    startedAtRef.current = null;
    sessionRef.current   = null;
    serviceRef.current   = null;
    setStep("select");
    setElapsed(0);
    setSession(null);
    setSvc(null);
    setLog([]);
    setError(null);
    setChannelState(null);
    setTotalCharged(0);
    setSettlementResult(null);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // UI
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-screen bg-background pb-20">

      {/* 헤더 */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3 flex items-center gap-3">
        <button onClick={() => navigate(-1)} className="text-muted-foreground hover:text-foreground">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <span className="font-semibold text-foreground">QR 결제</span>
        {step === "active" && (
          <span className="ml-auto text-xs font-mono text-muted-foreground">{fmt(elapsed)}</span>
        )}
      </div>

      <div className="flex-1 px-4 py-6 space-y-4 max-w-md mx-auto w-full">

        {/* ── 서비스 선택 ── */}
        {step === "select" && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 text-destructive text-sm mb-4">
                <AlertCircle className="w-4 h-4 shrink-0" /> {error}
              </div>
            )}
            <p className="text-sm text-muted-foreground mb-4">이용할 서비스를 선택하세요</p>
            <div className="space-y-3">
              {SERVICE_TYPES.map(s => (
                <button key={s.id} onClick={() => startSession(s)}
                  className="w-full flex items-center gap-4 p-4 rounded-2xl border border-border bg-card hover:bg-accent transition-colors text-left">
                  <span className="text-3xl">{s.emoji}</span>
                  <div>
                    <p className="font-semibold text-foreground">{s.label}</p>
                    <p className="text-xs text-muted-foreground">{s.rate} · 보증금 {s.depositUsdc} USDC</p>
                  </div>
                </button>
              ))}
            </div>
          </motion.div>
        )}

        {/* ── 처리 중 ── */}
        {step === "scanning" && (
          <motion.div className="flex flex-col items-center justify-center py-16 gap-4"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Loader2 className="w-10 h-10 animate-spin text-primary" />
            <p className="text-muted-foreground text-sm">MetaMask 서명 후 처리 중...</p>
            <LogPanel logs={log} />
          </motion.div>
        )}

        {/* ── 이용 중 (ACTIVE) ── */}
        {step === "active" && selectedService && (
          <motion.div className="space-y-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>

            {/* 타이머 + Perun 채널 상태 */}
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="text-center mb-4">
                <div className="text-4xl font-mono font-bold text-foreground mb-1">{fmt(elapsed)}</div>
                <div className="text-sm text-muted-foreground">
                  {selectedService.emoji} {selectedService.label} 이용 중
                </div>
              </div>

              {/* ★ Perun 채널 상태 카드 */}
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="bg-muted/50 rounded-xl p-2.5 text-center">
                  <p className="text-muted-foreground mb-0.5">누적 요금</p>
                  <p className="font-mono font-bold text-orange-400">
                    {totalChargedUsdc.toFixed(4)}
                  </p>
                  <p className="text-muted-foreground/60">USDC</p>
                </div>
                <div className="bg-muted/50 rounded-xl p-2.5 text-center">
                  <p className="text-muted-foreground mb-0.5">예상 환불</p>
                  <p className="font-mono font-bold text-green-400">
                    {(selectedService.depositUsdc - totalChargedUsdc).toFixed(4)}
                  </p>
                  <p className="text-muted-foreground/60">USDC</p>
                </div>
                <div className="bg-muted/50 rounded-xl p-2.5 text-center">
                  <p className="text-muted-foreground mb-0.5">채널 nonce</p>
                  <p className="font-mono font-bold text-primary">
                    #{channelState?.nonce ?? 0}
                  </p>
                  <p className="text-muted-foreground/60">Perun</p>
                </div>
              </div>

              {/* 진행 바 (잔액 비율) */}
              <div className="mt-3">
                <div className="w-full bg-muted rounded-full h-1.5">
                  <div
                    className="bg-orange-400 h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min((totalChargedUsdc / selectedService.depositUsdc) * 100, 100)}%` }}
                  />
                </div>
                <p className="text-[10px] text-muted-foreground mt-1 text-center">
                  ⚡ 60초마다 자동 차감 · 종료 시 잔금 자동 환불
                </p>
              </div>
            </div>

            {/* 로그 */}
            <LogPanel logs={log} />

            {/* 종료 버튼 */}
            <Button onClick={endSession} disabled={ending}
              className="w-full h-12 rounded-xl bg-destructive hover:bg-destructive/90 disabled:opacity-60">
              {ending
                ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> 정산 중...</>
                : <><Lock className="w-4 h-4 mr-2" /> 이용 종료 및 정산</>}
            </Button>
          </motion.div>
        )}

        {/* ── 정산 완료 ── */}
        {step === "ended" && (
          <motion.div className="flex flex-col items-center gap-4"
            initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}>

            <CheckCircle2 className="w-16 h-16 text-green-400 mt-4" />
            <div className="text-center">
              <p className="text-xl font-bold text-foreground">정산 완료</p>
              <p className="text-sm text-muted-foreground mt-1">이용 시간: {fmt(elapsed)}</p>
            </div>

            {/* ★ 정산 결과 카드 */}
            {settlementResult && (
              <div className="w-full rounded-2xl border border-border bg-card p-4 space-y-3">
                <p className="font-semibold text-foreground text-sm">정산 내역</p>

                {/* 예치금 분배 시각화 */}
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-sm">
                    <span className="text-muted-foreground">총 예치금</span>
                    <span className="font-mono">{selectedService?.depositUsdc?.toFixed(6)} USDC</span>
                  </div>
                  <div className="w-full flex rounded-lg overflow-hidden h-3">
                    <div
                      className="bg-orange-400 transition-all"
                      style={{ width: `${Math.min((parseFloat(settlementResult.fare) / (selectedService?.depositUsdc||1)) * 100, 100)}%` }}
                    />
                    <div className="bg-green-400 flex-1" />
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span className="text-orange-400">요금 {settlementResult.fare} USDC</span>
                    <span className="text-green-400">환불 {settlementResult.refund} USDC</span>
                  </div>
                </div>

                <div className="border-t border-border pt-3 space-y-1.5">
                  {/* 요금 */}
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">🏦 요금 (operator)</span>
                    <span className="font-mono text-orange-400 font-semibold">
                      -{settlementResult.fare} USDC
                    </span>
                  </div>
                  {/* 환불 */}
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">💚 환불 (즉시)</span>
                    <span className="font-mono text-green-400 font-semibold">
                      +{settlementResult.refund} USDC
                    </span>
                  </div>
                </div>

                {/* TX 링크 */}
                {settlementResult.txHash && (
                  <a
                    href={`https://sepolia.basescan.org/tx/${settlementResult.txHash}`}
                    target="_blank" rel="noopener noreferrer"
                    className="block text-center text-xs text-primary underline truncate"
                  >
                    온체인 확인 → {settlementResult.txHash.slice(0,22)}...
                  </a>
                )}
                {settlementResult.deferred && (
                  <p className="text-center text-xs text-muted-foreground">
                    ⏳ holdDeadline 후 자동 정산 예약됨 — 환불은 곧 도착합니다
                  </p>
                )}
              </div>
            )}

            {/* 로그 */}
            <LogPanel logs={log} />

            <Button onClick={reset} className="w-full rounded-xl">
              새 결제 시작
            </Button>
          </motion.div>
        )}
      </div>

      <BottomNav />
    </div>
  );
}

// ── 로그 패널 컴포넌트 ──────────────────────────────────────────────────────────
function LogPanel({ logs }) {
  if (!logs?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-3 space-y-1 max-h-44 overflow-y-auto">
      {logs.map((l, i) => (
        <div key={i} className={`text-[11px] flex gap-2 items-start ${
          l.type === "success" ? "text-green-400" :
          l.type === "error"   ? "text-destructive" :
          "text-muted-foreground"
        }`}>
          <span className="shrink-0 opacity-50">{l.ts}</span>
          <span>{l.msg}</span>
        </div>
      ))}
    </div>
  );
}
