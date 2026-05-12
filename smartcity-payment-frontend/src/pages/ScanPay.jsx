/**
 * ScanPay.jsx — QR 결제 메인 페이지
 *
 * 흐름:
 *  1) 서비스 선택
 *  2) /start → escrowId + holdDeadline 수신
 *  3) MetaMask approve + userDeposit (온체인 2회 서명)
 *  4) /deposit → 백엔드 operatorDeposit 자동 트리거 (FullyFunded)
 *  5) 서비스 이용 중 — 매 60초마다 /charge 호출 (Perun 마이크로 페이먼트)
 *     → Redis 채널 state 누적 업데이트
 *  6) 종료 버튼 → /charge (최종 증분) → MetaMask personal_sign → /end → settleAndRelease
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { CheckCircle2, AlertCircle, ArrowLeft, Loader2, Lock, Zap, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BottomNav from '@/components/wallet/BottomNav';
import {
  approveAndUserDeposit,
  waitForTx,
  personalSign,
  getUsdcBalance,
  ESCROW_V3_ADDRESS,
  OPERATOR_ADDRESS,
} from '@/lib/walletUtils';

const BACKEND = "https://smartcity-payment-backend-production.up.railway.app";
// Perun 마이크로 페이먼트: 60초마다 /charge 호출 (오프체인 state 누적)
const MICRO_CHARGE_INTERVAL_MS = 60_000;

async function apiCall(path, method = "GET", body = null) {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(
    data.errors?.[0] || data.error || "API Error"
  );
  return data.data ?? data;
}

const SERVICE_TYPES = [
  { id: "parking",     label: "주차",        emoji: "🚗", serviceId: "PARKING-LOT-A-001", rate: "0.02 USDC/min", depositUsdc: 5.0 },
  { id: "bicycle",     label: "공유 자전거", emoji: "🚴", serviceId: "BIKE-STATION-007",  rate: "0.01 USDC/min", depositUsdc: 3.0 },
  { id: "ev_charging", label: "전기차 충전", emoji: "⚡", serviceId: "EV-CHARGER-B-003",  rate: "0.25 USDC/kWh", depositUsdc: 10.0 },
];

const SESSION_KEY = "active_session";

function saveSession(service, sessionData, startedAt, depositTxHash, totalChargedUsdc = 0, lastChargeMinutes = 0) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({
    service, sessionData, startedAt, depositTxHash,
    totalChargedUsdc, lastChargeMinutes,
  }));
}

function clearSession() { localStorage.removeItem(SESSION_KEY); }

function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

export default function ScanPay() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [step, setStep] = useState("select"); // select | scanning | active | ending | ended
  const [selectedService, setSelectedService] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [elapsed, setElapsed] = useState(0);           // 경과 초
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [fareInfo, setFareInfo] = useState(null);
  const [depositTxHash, setDepositTxHash] = useState(null);
  // 누적 요금 (Perun: 매 60초 charge 누적)
  const [totalChargedUsdc, setTotalChargedUsdc] = useState(0);
  const [lastChargeMinutes, setLastChargeMinutes] = useState(0); // 이미 charge한 총 분

  const timerRef = useRef(null);
  const microChargeRef = useRef(null);
  const startedAtRef = useRef(null);
  const sessionDataRef = useRef(null); // 최신 sessionData를 closure에서 참조
  const serviceRef = useRef(null);
  const lastChargeMinRef = useRef(0);  // 이미 charge 완료한 누적 분

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];
  const mmAddress = localStorage.getItem("mm_address");

  const addLog = useCallback((msg, type = "info") =>
    setLog(prev => [...prev.slice(-29), { msg, type, ts: new Date().toLocaleTimeString() }]), []);

  const fmt = (s) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // ── 앱 재진입 시 세션 복원 ──────────────────────────────────────────────────
  useEffect(() => {
    const saved = loadSession();
    if (saved?.sessionData && saved?.service) {
      startedAtRef.current = saved.startedAt;
      sessionDataRef.current = saved.sessionData;
      serviceRef.current = saved.service;
      lastChargeMinRef.current = saved.lastChargeMinutes || 0;
      setSelectedService(saved.service);
      setSessionData(saved.sessionData);
      setElapsed(Math.floor((Date.now() - saved.startedAt) / 1000));
      setDepositTxHash(saved.depositTxHash || null);
      setTotalChargedUsdc(saved.totalChargedUsdc || 0);
      setLastChargeMinutes(saved.lastChargeMinutes || 0);
      setStep("active");
      addLog("⚠️ 세션 복원됨 — 종료 버튼을 눌러 정산하세요", "error");
    }
  }, [addLog]);

  // ── 초 타이머 ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (step === "active") {
      timerRef.current = setInterval(() => {
        if (startedAtRef.current)
          setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }, 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [step]);

  // ── Perun 마이크로 페이먼트 타이머 (60초마다 증분 charge) ──────────────────
  useEffect(() => {
    if (step !== "active") {
      clearInterval(microChargeRef.current);
      return;
    }

    microChargeRef.current = setInterval(async () => {
      const sd = sessionDataRef.current;
      const svc = serviceRef.current;
      if (!sd || !svc || !mmAddress) return;

      // 현재 총 경과 분
      const totalMinutes = startedAtRef.current
        ? (Date.now() - startedAtRef.current) / 60000
        : 0;

      // 이번 회차에서 새로 청구할 증분 분
      const incrementMinutes = totalMinutes - lastChargeMinRef.current;
      if (incrementMinutes < 0.5) return; // 너무 짧으면 스킵

      try {
        const chargeData = await apiCall(`/api/v1/sessions/${sd.sessionId}/charge`, "POST", {
          channelId:   sd.channelId,
          userAddress: mmAddress,
          serviceType: svc.id,
          usage: { durationMinutes: incrementMinutes },
        });

        const addedFare = parseFloat(chargeData.fare?.fareUsdc || "0");
        lastChargeMinRef.current = totalMinutes;
        setLastChargeMinutes(totalMinutes);
        setTotalChargedUsdc(prev => {
          const newTotal = prev + addedFare;
          // localStorage 업데이트
          const saved = loadSession();
          if (saved) saveSession(saved.service, saved.sessionData, saved.startedAt, saved.depositTxHash, newTotal, totalMinutes);
          return newTotal;
        });
        addLog(`💸 마이크로 charge +${chargeData.fare?.fareUsdc} USDC (${fmt(Math.round(totalMinutes*60))} 누적)`, "success");
      } catch (e) {
        addLog(`⚠️ 자동 charge 실패: ${e.message}`, "error");
      }
    }, MICRO_CHARGE_INTERVAL_MS);

    return () => clearInterval(microChargeRef.current);
  }, [step, mmAddress, addLog]);

  // ── 세션 시작 ──────────────────────────────────────────────────────────────
  const startSession = async (service) => {
    const existingSession = loadSession();
    if (existingSession?.sessionData) {
      setError(`이미 진행 중인 세션(${existingSession.service?.emoji} ${existingSession.service?.label})이 있습니다.`);
      return;
    }

    setSelectedService(service);
    serviceRef.current = service;
    setStep("scanning");
    setError(null);
    addLog(`QR 스캔: ${service.serviceId}`, "info");

    try {
      // STEP 1: /start → escrowId, holdDeadline 수신
      addLog("🔄 백엔드 세션 초기화 중...", "info");
      const data = await apiCall("/api/v1/sessions/start", "POST", {
        userAddress: mmAddress,
        serviceType: service.id,
        depositUsdc: String(service.depositUsdc),
      });

      const escrowId    = data.escrowId;
      const holdDeadline = Number(data.holdDeadline); // unix seconds 그대로
      addLog(`📋 세션: ${data.sessionId?.slice(0, 12)}...`, "info");
      addLog(`⏰ holdDeadline: ${new Date(holdDeadline * 1000).toLocaleTimeString()} 까지`, "info");

      // STEP 2: approve + userDeposit (MetaMask 2회)
      addLog(`💳 MetaMask approve → userDeposit (${service.depositUsdc} USDC)...`, "info");
      const txHash = await approveAndUserDeposit(
        mmAddress, escrowId, OPERATOR_ADDRESS, service.depositUsdc, holdDeadline
      );
      setDepositTxHash(txHash);
      addLog(`⏳ TX 확정 대기...`, "info");
      await waitForTx(txHash, 90000);
      addLog(`✅ 온체인 예치 완료 — ${txHash.slice(0, 16)}...`, "success");

      // STEP 3: /deposit → operatorDeposit 자동 트리거
      await apiCall(`/api/v1/sessions/${data.sessionId}/deposit`, "POST", {
        channelId:       data.channelId,
        userAddress:     mmAddress,
        operatorAddress: OPERATOR_ADDRESS,
        depositUsdc:     String(service.depositUsdc),
        holdDeadline,
        depositTxHash:   txHash,
      });
      addLog(`🏦 에스크로 기록 완료 — 운영자 보증금 자동 예치 중...`, "info");

      // STEP 4: 세션 활성화
      const now = Date.now();
      startedAtRef.current = now;
      sessionDataRef.current = data;
      lastChargeMinRef.current = 0;
      setSessionData(data);
      setTotalChargedUsdc(0);
      setLastChargeMinutes(0);
      saveSession(service, data, now, txHash, 0, 0);
      setStep("active");
      addLog(`✅ 세션 시작! 매 1분마다 자동 요금 적립`, "success");

      // STEP 5: DB + 잔액
      try {
        await base44.entities.Transaction.create({
          type: 'session_start', amount: service.depositUsdc, status: 'active',
          to_address: ESCROW_V3_ADDRESS, from_address: mmAddress,
          merchant_name: `${service.emoji} ${service.label}`,
          tx_hash: txHash, wallet_id: wallet?.id,
          note: `세션ID: ${data.sessionId}`,
        });
        const newBal = await getUsdcBalance(mmAddress);
        localStorage.setItem("mm_balance", newBal);
        if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: newBal });
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        queryClient.invalidateQueries({ queryKey: ['wallets'] });
      } catch {}

    } catch (e) {
      setError(e.message);
      setStep("select");
      addLog(`❌ 실패: ${e.message}`, "error");
    }
  };

  // ── 세션 종료 ──────────────────────────────────────────────────────────────
  const endSession = async () => {
    if (step === "ending") return;
    setStep("ending");
    clearInterval(microChargeRef.current);

    const sd  = sessionDataRef.current;
    const svc = serviceRef.current;
    const totalMinutes = startedAtRef.current
      ? (Date.now() - startedAtRef.current) / 60000
      : elapsed / 60;

    // STEP 1: 최종 증분 charge (마지막 micro-charge 이후 남은 시간)
    let finalFareUsdc = 0;
    let stateHash = null;
    let operatorSig = null;

    const remainMinutes = totalMinutes - lastChargeMinRef.current;
    if (remainMinutes > 0.1) {
      try {
        addLog(`💰 최종 요금 계산 중 (+${remainMinutes.toFixed(1)}분)...`, "info");
        const chargeData = await apiCall(`/api/v1/sessions/${sd.sessionId}/charge`, "POST", {
          channelId:   sd.channelId,
          userAddress: mmAddress,
          serviceType: svc.id,
          usage: { durationMinutes: remainMinutes },
        });
        finalFareUsdc = parseFloat(chargeData.fare?.fareUsdc || "0");
        // BUG-7 수정: stateHash는 signatureRequest 안에 있음
        stateHash   = chargeData.signatureRequest?.stateHash;
        operatorSig = chargeData.signatureRequest?.operatorSig;
        addLog(`💰 증분 요금: ${chargeData.fare?.fareUsdc} USDC`, "success");
      } catch (e) {
        addLog(`⚠️ 최종 charge 실패: ${e.message}`, "error");
      }
    }

    // 총 요금 = 누적 + 최종 증분
    const totalFareUsdc = totalChargedUsdc + finalFareUsdc;
    setFareInfo({
      fareUsdc: totalFareUsdc.toFixed(6),
      durationMin: totalMinutes.toFixed(1),
    });
    addLog(`📊 총 요금: ${totalFareUsdc.toFixed(6)} USDC (${totalMinutes.toFixed(1)}분)`, "success");

    // STEP 2: MetaMask personal_sign
    let userFinalSig = "0xmock_signature_for_demo";
    if (stateHash) {
      try {
        addLog("✍️ MetaMask 서명 요청...", "info");
        userFinalSig = await personalSign(mmAddress, stateHash);
        addLog("✅ 서명 완료", "success");
      } catch (e) {
        addLog(`⚠️ 서명 취소 — mock 서명 사용: ${e.message}`, "error");
      }
    }

    // STEP 3: /end → settleAndRelease 트리거
    try {
      const endData = await apiCall(`/api/v1/sessions/${sd.sessionId}/end`, "POST", {
        channelId:    sd.channelId,
        userAddress:  mmAddress,
        userFinalSig,
        fareUsdc:     totalFareUsdc.toFixed(6), // 반드시 전달
      });
      const txHash = endData?.txHash || endData?.escrow?.txHash;
      if (txHash && !txHash.startsWith('0xmock')) {
        addLog(`🏁 온체인 정산 TX: ${txHash.slice(0, 16)}...`, "success");
        addLog(`🔗 https://sepolia.basescan.org/tx/${txHash}`, "success");
      } else {
        addLog(`🏁 세션 종료 완료`, "success");
        if (endData?.escrow?.reason) {
          addLog(`ℹ️ ${endData.escrow.reason}`, "error");
        }
      }
    } catch (e) {
      addLog(`⚠️ 세션 종료 API 오류: ${e.message}`, "error");
    }

    // STEP 4: DB + 잔액
    try {
      await base44.entities.Transaction.create({
        type: 'payment', amount: totalFareUsdc, status: 'completed',
        to_address: svc.serviceId, from_address: mmAddress,
        merchant_name: `${svc.emoji} ${svc.label}`,
        tx_hash: sd.sessionId, wallet_id: wallet?.id,
      });
      const newBal = await getUsdcBalance(mmAddress);
      localStorage.setItem("mm_balance", newBal);
      if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: newBal });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    } catch {}

    clearSession();
    setStep("ended");
  };

  const reset = () => {
    clearSession();
    startedAtRef.current = null;
    sessionDataRef.current = null;
    serviceRef.current = null;
    lastChargeMinRef.current = 0;
    setStep("select"); setElapsed(0); setLog([]);
    setSessionData(null); setSelectedService(null); setError(null);
    setFareInfo(null); setDepositTxHash(null);
    setTotalChargedUsdc(0); setLastChargeMinutes(0);
  };

  // ── MetaMask 미연결 ────────────────────────────────────────────────────────
  if (!mmAddress) return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
      <Lock className="w-12 h-12 text-muted-foreground mb-4" />
      <h2 className="text-lg font-semibold mb-2">MetaMask 연결 필요</h2>
      <p className="text-sm text-muted-foreground text-center mb-6">
        QR 결제는 MetaMask 지갑 연결 후 이용할 수 있습니다.
      </p>
      <Button onClick={() => navigate('/')} className="rounded-xl px-6">홈으로</Button>
      <BottomNav />
    </div>
  );

  // ── SELECT ─────────────────────────────────────────────────────────────────
  if (step === "select") return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">QR 결제</h1>
            <p className="text-xs text-muted-foreground">서비스 선택 → MetaMask 서명 → 이용 시작</p>
          </div>
        </div>
        {error && (
          <motion.div initial={{ opacity:0, y:-10 }} animate={{ opacity:1, y:0 }}
            className="flex items-start gap-2 p-3 mb-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />{error}
          </motion.div>
        )}
        <div className="space-y-3">
          {SERVICE_TYPES.map(service => (
            <motion.button key={service.id} whileTap={{ scale: 0.97 }}
              onClick={() => startSession(service)}
              className="w-full flex items-center justify-between p-4 rounded-2xl bg-card border border-border hover:border-primary/40 hover:bg-primary/5 transition-all text-left">
              <div className="flex items-center gap-3">
                <span className="text-2xl">{service.emoji}</span>
                <div>
                  <p className="font-semibold text-sm">{service.label}</p>
                  <p className="text-xs text-muted-foreground">{service.rate}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-primary">{service.depositUsdc} USDC</p>
                <p className="text-[10px] text-muted-foreground">보증금</p>
              </div>
            </motion.button>
          ))}
        </div>
        <div className="mt-6 p-3 rounded-xl bg-primary/5 border border-primary/10">
          <p className="text-[11px] text-muted-foreground text-center leading-relaxed">
            <Zap className="inline w-3 h-3 mr-1 text-primary" />
            Perun 마이크로 페이먼트 — 매 1분마다 자동 요금 적립<br/>
            SmartCityEscrowV3 · {ESCROW_V3_ADDRESS.slice(0,10)}...{ESCROW_V3_ADDRESS.slice(-6)}
          </p>
        </div>
      </div>
      <BottomNav />
    </div>
  );

  // ── SCANNING ────────────────────────────────────────────────────────────────
  if (step === "scanning") return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
      <Loader2 className="w-10 h-10 text-primary animate-spin mb-4" />
      <h2 className="text-base font-semibold mb-1">에스크로 예치 처리 중</h2>
      <p className="text-xs text-muted-foreground text-center mb-4">
        MetaMask에서 approve → userDeposit 순서로 서명해주세요
      </p>
      <div className="w-full max-w-sm space-y-1 mt-2 max-h-64 overflow-y-auto">
        {log.map((l, i) => (
          <div key={i} className={`text-[11px] px-3 py-1.5 rounded-lg ${
            l.type==="success" ? "bg-green-500/10 text-green-600"
            : l.type==="error" ? "bg-destructive/10 text-destructive"
            : "bg-secondary text-muted-foreground"}`}>
            <span className="opacity-50 mr-1">{l.ts}</span>{l.msg}
          </div>
        ))}
      </div>
    </div>
  );

  // ── ACTIVE ──────────────────────────────────────────────────────────────────
  if (step === "active" || step === "ending") return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${step==="ending" ? "bg-yellow-500 animate-pulse" : "bg-green-500 animate-pulse"}`} />
              <h1 className="text-base font-semibold">
                {selectedService?.emoji} {selectedService?.label} {step==="ending" ? "정산 중..." : "이용 중"}
              </h1>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Perun 채널 활성 · 매 1분 자동 적립
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold font-mono text-primary">{fmt(elapsed)}</p>
            <p className="text-[10px] text-muted-foreground">경과</p>
          </div>
        </div>

        {/* 세션 정보 카드 */}
        <div className="rounded-2xl bg-card border border-border p-4 mb-3 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">세션 ID</span>
            <span className="font-mono">{sessionData?.sessionId?.slice(0, 16)}...</span>
          </div>
          {depositTxHash && (
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">예치 TX</span>
              <a href={`https://sepolia.basescan.org/tx/${depositTxHash}`}
                target="_blank" rel="noreferrer"
                className="font-mono text-primary hover:underline truncate max-w-[160px]">
                {depositTxHash.slice(0, 16)}...
              </a>
            </div>
          )}
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">보증금</span>
            <span className="font-semibold text-primary">{selectedService?.depositUsdc} USDC</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">요금</span>
            <span>{selectedService?.rate}</span>
          </div>
        </div>

        {/* 누적 요금 실시간 표시 */}
        <div className="rounded-2xl bg-primary/5 border border-primary/20 p-4 mb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-primary" />
              <span className="text-xs text-muted-foreground">누적 청구 요금</span>
            </div>
            <span className="text-lg font-bold text-primary">{totalChargedUsdc.toFixed(4)} USDC</span>
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>마지막 charge: {fmt(Math.round(lastChargeMinutes * 60))} 시점</span>
            <span>다음: {fmt(Math.max(0, 60 - (elapsed % 60)))} 후</span>
          </div>
        </div>

        {/* 로그 */}
        <div className="rounded-2xl bg-card border border-border p-3 mb-4 max-h-32 overflow-y-auto space-y-0.5">
          {log.length === 0 && <p className="text-[10px] text-muted-foreground">로그 없음</p>}
          {log.map((l, i) => (
            <div key={i} className={`text-[10px] ${
              l.type==="success" ? "text-green-600"
              : l.type==="error" ? "text-destructive"
              : "text-muted-foreground"}`}>
              <span className="opacity-50 mr-1">{l.ts}</span>{l.msg}
            </div>
          ))}
        </div>

        <Button onClick={endSession} disabled={step==="ending"}
          className="w-full rounded-2xl py-6 text-base font-semibold bg-destructive hover:bg-destructive/90">
          {step==="ending"
            ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" />정산 처리 중...</>
            : "🏁 서비스 종료 & 정산"}
        </Button>
      </div>
      <BottomNav />
    </div>
  );

  // ── ENDED ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
      <motion.div initial={{ scale:0 }} animate={{ scale:1 }} transition={{ type:"spring" }}>
        <CheckCircle2 className="w-16 h-16 text-green-500 mb-4" />
      </motion.div>
      <h2 className="text-lg font-semibold mb-1">정산 완료</h2>
      {fareInfo && (
        <div className="w-full max-w-sm rounded-2xl bg-card border border-border p-4 my-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">최종 요금</span>
            <span className="font-bold text-primary">{fareInfo.fareUsdc} USDC</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">이용 시간</span>
            <span>{fareInfo.durationMin} 분</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">예상 환불</span>
            <span className="text-green-600 font-semibold">
              {Math.max(0, (selectedService?.depositUsdc || 0) - parseFloat(fareInfo.fareUsdc)).toFixed(4)} USDC
            </span>
          </div>
        </div>
      )}
      <div className="w-full max-w-sm space-y-1 mb-6 max-h-40 overflow-y-auto">
        {log.slice(-8).map((l, i) => (
          <div key={i} className={`text-[11px] px-3 py-1.5 rounded-lg ${
            l.type==="success" ? "bg-green-500/10 text-green-600"
            : l.type==="error" ? "bg-destructive/10 text-destructive"
            : "bg-secondary text-muted-foreground"}`}>{l.msg}</div>
        ))}
      </div>
      <Button onClick={reset} className="rounded-xl px-8">새 결제 시작</Button>
      <BottomNav />
    </div>
  );
}
