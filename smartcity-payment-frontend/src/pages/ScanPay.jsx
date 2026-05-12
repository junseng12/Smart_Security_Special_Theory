import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { CheckCircle2, Zap, AlertCircle, ArrowLeft, Loader2, Lock } from 'lucide-react';
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
function saveSession(service, sessionData, startedAt, depositTxHash) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ service, sessionData, startedAt, depositTxHash }));
}
function clearSession() { localStorage.removeItem(SESSION_KEY); }
function loadSession()  {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

export default function ScanPay() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState("select");
  const [selectedService, setSelectedService] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [elapsed, setElapsed] = useState(0);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [fareInfo, setFareInfo] = useState(null);
  const [ending, setEnding] = useState(false);
  const [depositTxHash, setDepositTxHash] = useState(null);
  const timerRef = useRef(null);
  const startedAtRef = useRef(null);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];
  const mmAddress = localStorage.getItem("mm_address");

  // 앱 재진입 시 세션 복원
  useEffect(() => {
    const saved = loadSession();
    if (saved?.sessionData && saved?.service) {
      startedAtRef.current = saved.startedAt;
      setSelectedService(saved.service);
      setSessionData(saved.sessionData);
      setElapsed(Math.floor((Date.now() - saved.startedAt) / 1000));
      setDepositTxHash(saved.depositTxHash || null);
      setStep("active");
      setLog([{ msg: "⚠️ 세션 복원됨 — 종료 버튼을 눌러 정산하세요", type: "error", ts: new Date().toLocaleTimeString() }]);
    }
  }, []);

  // 타이머
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

  const addLog = (msg, type = "info") =>
    setLog(prev => [...prev, { msg, type, ts: new Date().toLocaleTimeString() }]);

  const fmt = (s) =>
    `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  // ── 세션 시작 ──────────────────────────────────────────────────────────────
  const startSession = async (service) => {
    const existingSession = loadSession();
    if (existingSession?.sessionData) {
      setError(`이미 진행 중인 세션(${existingSession.service?.emoji} ${existingSession.service?.label})이 있습니다.`);
      return;
    }
    setSelectedService(service);
    setStep("scanning");
    setError(null);
    addLog(`QR 스캔: ${service.serviceId}`, "info");

    try {
      // ── STEP 1: 백엔드 세션 시작 → escrowId, holdDeadline 수신 ──
      addLog("🔄 백엔드 세션 초기화 중...", "info");
      const data = await apiCall("/api/v1/sessions/start", "POST", {
        userAddress: mmAddress,
        serviceType: service.id,
        depositUsdc: String(service.depositUsdc),
      });

      // escrowId: 백엔드에서 keccak256(sessionId) → 0x+64hex
      const escrowId = data.escrowId;
      // holdDeadline: 백엔드가 unix seconds 정수로 반환 (new Date() 하면 1970년 됨)
      const holdDeadline = Number(data.holdDeadline);
      addLog(`📋 세션 ID: ${data.sessionId?.slice(0, 12)}...`, "info");
      addLog(`🔑 escrowId: ${escrowId?.slice(0, 18)}...`, "info");
      addLog(`⏰ holdDeadline: ${new Date(holdDeadline * 1000).toLocaleTimeString()} 까지`, "info");

      // ── STEP 2: approve + userDeposit (MetaMask 2회 서명) ──
      addLog(`💳 MetaMask에서 ${service.depositUsdc} USDC approve 승인 요청...`, "info");
      const txHash = await approveAndUserDeposit(
        mmAddress,
        escrowId,
        OPERATOR_ADDRESS,
        service.depositUsdc,
        holdDeadline
      );
      setDepositTxHash(txHash);
      addLog(`⏳ userDeposit TX 확정 대기 중...`, "info");
      await waitForTx(txHash, 90000);
      addLog(`✅ 온체인 예치 완료 — ${txHash.slice(0, 16)}...`, "success");

      // ── STEP 3: 백엔드에 deposit 기록 → operatorDeposit 자동 트리거 ──
      await apiCall(`/api/v1/sessions/${data.sessionId}/deposit`, "POST", {
        channelId:       data.channelId,
        userAddress:     mmAddress,
        operatorAddress: OPERATOR_ADDRESS,
        depositUsdc:     String(service.depositUsdc),
        holdDeadline,
        depositTxHash:   txHash,
      });
      addLog(`🏦 에스크로 기록 완료 — 운영자 보증금 자동 예치 진행 중...`, "info");

      // ── STEP 4: 세션 활성화 ──
      const now = Date.now();
      startedAtRef.current = now;
      setSessionData(data);
      saveSession(service, data, now, txHash);
      setStep("active");
      addLog(`✅ 세션 시작!`, "success");

      // ── STEP 5: DB + 잔액 갱신 ──
      try {
        await base44.entities.Transaction.create({
          type: 'session_start',
          amount: service.depositUsdc,
          status: 'active',
          to_address: ESCROW_V3_ADDRESS,
          from_address: mmAddress,
          merchant_name: `${service.emoji} ${service.label}`,
          tx_hash: txHash,
          wallet_id: wallet?.id,
          note: `세션ID: ${data.sessionId}`,
        });
        const newBal = await getUsdcBalance(mmAddress);
        localStorage.setItem("mm_balance", newBal);
        if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: newBal });
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        queryClient.invalidateQueries({ queryKey: ['wallets'] });
      } catch (e) {
        addLog(`⚠️ DB 기록 오류 (무시): ${e.message}`, "error");
      }

    } catch (e) {
      setError(e.message);
      setStep("select");
      addLog(`❌ 실패: ${e.message}`, "error");
    }
  };

  // ── 세션 종료 ──────────────────────────────────────────────────────────────
  const endSession = async () => {
    if (ending) return;
    setEnding(true);
    const durationMinutes = Math.max(elapsed / 60, 1/60); // 최소 1초

    // ── STEP 1: charge → fareUsdc + stateHash 수신 ──
    let fareUsdc = 0;
    let stateHash = null;
    let operatorSig = null;
    try {
      const chargeData = await apiCall(`/api/v1/sessions/${sessionData.sessionId}/charge`, "POST", {
        channelId: sessionData.channelId,
        userAddress: mmAddress,
        serviceType: selectedService.id,
        usage: { durationMinutes },
      });
      fareUsdc = parseFloat(chargeData.fare?.fareUsdc || "0");
      stateHash = chargeData.stateHash;
      operatorSig = chargeData.operatorSig;
      setFareInfo(chargeData.fare);
      addLog(`💰 요금: ${chargeData.fare?.fareUsdc || "0"} USDC`, "success");
    } catch (e) {
      addLog(`⚠️ 요금 계산 실패 (계속 진행): ${e.message}`, "error");
    }

    // ── STEP 2: MetaMask personal_sign (stateHash 있을 때만) ──
    let userFinalSig = "0xmock_signature_for_demo";
    if (stateHash) {
      try {
        addLog("✍️ MetaMask에서 정산 서명 요청...", "info");
        userFinalSig = await personalSign(mmAddress, stateHash);
        addLog("✅ 서명 완료", "success");
      } catch (e) {
        addLog(`⚠️ 서명 취소/실패, mock 서명 사용: ${e.message}`, "error");
      }
    }

    // ── STEP 3: 세션 종료 (settleAndRelease 트리거) ──
    try {
      const endData = await apiCall(`/api/v1/sessions/${sessionData.sessionId}/end`, "POST", {
        channelId:    sessionData.channelId,
        userAddress:  mmAddress,
        userFinalSig,
        fareUsdc:     fareUsdc.toFixed(6),
      });
      addLog(`🏁 정산 완료 — TX: ${endData?.txHash?.slice(0, 16) || "처리 중"}...`, "success");
      if (endData?.txHash) {
        addLog(`🔗 https://sepolia.basescan.org/tx/${endData.txHash}`, "success");
      }
    } catch (e) {
      addLog(`⚠️ 세션 종료 API 오류: ${e.message}`, "error");
    }

    // ── STEP 4: DB 기록 + 잔액 갱신 ──
    try {
      await base44.entities.Transaction.create({
        type: 'payment',
        amount: fareUsdc,
        status: 'completed',
        to_address: selectedService.serviceId,
        from_address: mmAddress,
        merchant_name: `${selectedService.emoji} ${selectedService.label}`,
        tx_hash: sessionData.sessionId,
        wallet_id: wallet?.id,
      });
      const newBal = await getUsdcBalance(mmAddress);
      localStorage.setItem("mm_balance", newBal);
      if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: newBal });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    } catch (e) {
      addLog(`⚠️ DB 기록 오류: ${e.message}`, "error");
    }

    clearSession();
    setEnding(false);
    setStep("ended");
  };

  const reset = () => {
    clearSession();
    startedAtRef.current = null;
    setStep("select");
    setElapsed(0);
    setLog([]);
    setSessionData(null);
    setSelectedService(null);
    setError(null);
    setFareInfo(null);
    setEnding(false);
    setDepositTxHash(null);
  };

  // ── MetaMask 미연결 ──────────────────────────────────────────────────────────
  if (!mmAddress) return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
      <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
        <Lock className="w-8 h-8 text-muted-foreground" />
      </div>
      <h2 className="text-lg font-semibold mb-2">MetaMask 연결 필요</h2>
      <p className="text-sm text-muted-foreground text-center mb-6">
        QR 결제는 MetaMask 지갑 연결 후 이용할 수 있습니다.<br/>
        테스트넷 USDC가 실제로 전송됩니다.
      </p>
      <Button onClick={() => navigate('/')} className="rounded-xl px-6">홈으로 돌아가기</Button>
      <BottomNav />
    </div>
  );

  // ── SELECT ──────────────────────────────────────────────────────────────────
  if (step === "select") return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">QR 결제</h1>
            <p className="text-xs text-muted-foreground">서비스 선택 → MetaMask 2회 서명 (approve + deposit)</p>
          </div>
        </div>
        {error && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
            className="flex items-start gap-2 p-3 mb-4 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />{error}
          </motion.div>
        )}
        <div className="space-y-3">
          {SERVICE_TYPES.map(service => (
            <motion.button
              key={service.id}
              whileTap={{ scale: 0.97 }}
              onClick={() => startSession(service)}
              className="w-full flex items-center justify-between p-4 rounded-2xl bg-card border border-border hover:border-primary/40 hover:bg-primary/5 transition-all text-left"
            >
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
        <p className="text-[11px] text-muted-foreground text-center mt-6 leading-relaxed">
          SmartCityEscrowV3 · Base Sepolia<br/>
          {ESCROW_V3_ADDRESS.slice(0,10)}...{ESCROW_V3_ADDRESS.slice(-8)}
        </p>
      </div>
      <BottomNav />
    </div>
  );

  // ── SCANNING ─────────────────────────────────────────────────────────────────
  if (step === "scanning") return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
      <Loader2 className="w-10 h-10 text-primary animate-spin mb-4" />
      <h2 className="text-base font-semibold mb-1">에스크로 예치 처리 중</h2>
      <p className="text-xs text-muted-foreground text-center mb-4">
        MetaMask에서 approve → userDeposit 순서로 서명해주세요
      </p>
      <div className="w-full max-w-sm space-y-1 mt-2">
        {log.map((l, i) => (
          <div key={i} className={`text-[11px] px-3 py-1.5 rounded-lg ${
            l.type === "success" ? "bg-green-500/10 text-green-600"
            : l.type === "error" ? "bg-destructive/10 text-destructive"
            : "bg-secondary text-muted-foreground"
          }`}>
            <span className="text-muted-foreground/60 mr-1">{l.ts}</span>{l.msg}
          </div>
        ))}
      </div>
    </div>
  );

  // ── ACTIVE ───────────────────────────────────────────────────────────────────
  if (step === "active") return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-6">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <h1 className="text-base font-semibold">
                {selectedService?.emoji} {selectedService?.label} 이용 중
              </h1>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              에스크로 예치 완료 · Perun 채널 활성
            </p>
          </div>
          <div className="text-right">
            <p className="text-2xl font-bold font-mono text-primary">{fmt(elapsed)}</p>
            <p className="text-[10px] text-muted-foreground">경과 시간</p>
          </div>
        </div>

        {/* 세션 정보 */}
        <div className="rounded-2xl bg-card border border-border p-4 mb-4 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">세션 ID</span>
            <span className="font-mono">{sessionData?.sessionId?.slice(0, 16)}...</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">예치 TX</span>
            <a href={`https://sepolia.basescan.org/tx/${depositTxHash}`} target="_blank" rel="noreferrer"
              className="font-mono text-primary hover:underline">
              {depositTxHash?.slice(0, 16)}...
            </a>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">보증금</span>
            <span className="font-semibold text-primary">{selectedService?.depositUsdc} USDC</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">요금</span>
            <span>{selectedService?.rate}</span>
          </div>
        </div>

        {/* 로그 */}
        <div className="rounded-2xl bg-card border border-border p-3 mb-4 max-h-36 overflow-y-auto space-y-1">
          {log.map((l, i) => (
            <div key={i} className={`text-[10px] ${
              l.type === "success" ? "text-green-600"
              : l.type === "error" ? "text-destructive"
              : "text-muted-foreground"
            }`}>
              <span className="opacity-50 mr-1">{l.ts}</span>{l.msg}
            </div>
          ))}
        </div>

        <Button
          onClick={endSession}
          disabled={ending}
          className="w-full rounded-2xl py-6 text-base font-semibold bg-destructive hover:bg-destructive/90"
        >
          {ending ? <><Loader2 className="w-5 h-5 mr-2 animate-spin" />정산 처리 중...</>
                  : "🏁 서비스 종료 & 정산"}
        </Button>
      </div>
      <BottomNav />
    </div>
  );

  // ── ENDED ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring" }}>
        <CheckCircle2 className="w-16 h-16 text-green-500 mb-4" />
      </motion.div>
      <h2 className="text-lg font-semibold mb-1">정산 완료</h2>
      {fareInfo && (
        <div className="w-full max-w-sm rounded-2xl bg-card border border-border p-4 my-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">이용 요금</span>
            <span className="font-bold text-primary">{fareInfo.fareUsdc} USDC</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">이용 시간</span>
            <span>{fareInfo.durationMin} 분</span>
          </div>
        </div>
      )}
      <div className="w-full max-w-sm space-y-1 mb-6">
        {log.slice(-5).map((l, i) => (
          <div key={i} className={`text-[11px] px-3 py-1.5 rounded-lg ${
            l.type === "success" ? "bg-green-500/10 text-green-600"
            : l.type === "error" ? "bg-destructive/10 text-destructive"
            : "bg-secondary text-muted-foreground"
          }`}>{l.msg}</div>
        ))}
      </div>
      <Button onClick={reset} className="rounded-xl px-8">새 결제 시작</Button>
      <BottomNav />
    </div>
  );
}
