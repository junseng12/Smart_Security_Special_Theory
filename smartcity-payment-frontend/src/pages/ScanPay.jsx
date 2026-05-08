import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowLeft, CheckCircle2, Zap, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BottomNav from '@/components/wallet/BottomNav';

const BACKEND = "https://smartcity-payment-backend-production.up.railway.app";

async function apiCall(path, method = "GET", body = null) {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(
    (data.errors && data.errors[0]) || data.error || "API Error"
  );
  return data.data ?? data;
}

const SERVICE_TYPES = [
  { id: "parking",     label: "주차",        emoji: "🚗", rate: "0.05 USDC/min" },
  { id: "transit",     label: "대중교통",    emoji: "🚌", rate: "1.50 USDC/회"  },
  { id: "bike",        label: "공유 자전거", emoji: "🚴", rate: "0.03 USDC/min" },
  { id: "ev_charging", label: "전기차 충전", emoji: "⚡", rate: "0.10 USDC/min" },
];

export default function ScanPay() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState("select"); // select | scanning | active | ended
  const [selectedService, setSelectedService] = useState(null);
  const [sessionData, setSessionData] = useState(null);  // { sessionId, channelId, ... }
  const [elapsed, setElapsed] = useState(0);
  const [fareInfo, setFareInfo] = useState(null);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const timerRef = useRef(null);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];

  useEffect(() => {
    if (step === "active") {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
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
    setSelectedService(service);
    setStep("scanning");
    setError(null);
    setLog([]);
    addLog(`${service.emoji} ${service.label} QR 인식됨`, "info");
    try {
      const data = await apiCall("/api/v1/sessions/start", "POST", {
        userAddress: wallet?.address || "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7",
        serviceType: service.id,
        depositUsdc: "5.0",
      });
      setSessionData(data);
      setStep("active");
      addLog(`✅ 세션 시작 — ${data.sessionId?.slice(0, 12)}...`, "success");
      addLog(`🔗 채널 오픈 — ${data.channelId}`, "success");

      await base44.entities.Transaction.create({
        type: 'session_start',
        amount: 5.0,
        status: 'active',
        to_address: service.id,
        from_address: wallet?.address || "0x...",
        merchant_name: `${service.emoji} ${service.label}`,
        tx_hash: data.sessionId || "pending",
        wallet_id: wallet?.id,
      });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
    } catch (e) {
      setError(e.message);
      setStep("select");
      addLog(`❌ 실패: ${e.message}`, "error");
    }
  };

  // ── 요금 청구 ──────────────────────────────────────────────────────────────
  const chargeSession = async () => {
    try {
      const data = await apiCall(`/api/v1/sessions/${sessionData.sessionId}/charge`, "POST", {
        channelId: sessionData.channelId,
        userAddress: wallet?.address || "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7",
        serviceType: selectedService.id,
        usage: {},
      });
      setFareInfo(data.fare);
      addLog(`💰 청구: ${data.fare?.fareUsdc || "0"} USDC`, "success");
    } catch (e) {
      addLog(`⚠️ 청구 오류: ${e.message}`, "error");
    }
  };

  // ── 세션 종료 ──────────────────────────────────────────────────────────────
  const endSession = async () => {
    try {
      // 먼저 최종 charge로 fare 계산
      const chargeData = await apiCall(`/api/v1/sessions/${sessionData.sessionId}/charge`, "POST", {
        channelId: sessionData.channelId,
        userAddress: wallet?.address || "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7",
        serviceType: selectedService.id,
        usage: {},
      });
      const stateHash = chargeData.signatureRequest?.stateHash || "0x0";
      const fareUsdc = parseFloat(chargeData.fare?.fareUsdc || "0");

      // 종료 요청 (mock 서명)
      await apiCall(`/api/v1/sessions/${sessionData.sessionId}/end`, "POST", {
        channelId: sessionData.channelId,
        userAddress: wallet?.address || "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7",
        userFinalSig: `0xMOCK_FINAL_SIG_${Date.now()}`,
      });

      // DB 기록
      await base44.entities.Transaction.create({
        type: 'payment',
        amount: fareUsdc,
        status: 'completed',
        to_address: selectedService.id,
        from_address: wallet?.address || "0x...",
        merchant_name: `${selectedService.emoji} ${selectedService.label}`,
        tx_hash: stateHash,
        wallet_id: wallet?.id,
      });
      if (wallet) {
        await base44.entities.Wallet.update(wallet.id, {
          balance: Math.max(0, (wallet.balance || 0) - fareUsdc),
        });
      }
      setFareInfo(chargeData.fare);
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
      setStep("ended");
      addLog(`🏁 정산 완료! ${fareUsdc} USDC`, "success");
    } catch (e) {
      // end API가 서명 오류를 반환해도 mock 환경에서는 진행
      if (e.message.includes("signature") || e.message.includes("Invalid")) {
        setStep("ended");
        addLog(`🏁 세션 종료 (mock 모드)`, "success");
        queryClient.invalidateQueries({ queryKey: ['transactions'] });
        queryClient.invalidateQueries({ queryKey: ['wallets'] });
      } else {
        addLog(`❌ 종료 오류: ${e.message}`, "error");
      }
    }
  };

  const reset = () => {
    setStep("select");
    setElapsed(0);
    setLog([]);
    setSessionData(null);
    setSelectedService(null);
    setFareInfo(null);
    setError(null);
  };

  // ── SELECT ────────────────────────────────────────────────────────────────
  if (step === "select") return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">QR 결제</h1>
            <p className="text-xs text-muted-foreground">서비스를 선택하면 Perun 채널이 열립니다</p>
          </div>
        </div>

        {error && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm mb-4">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </motion.div>
        )}

        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">서비스 유형</p>
        <div className="grid grid-cols-2 gap-3 mb-6">
          {SERVICE_TYPES.map((s) => (
            <motion.button key={s.id} whileTap={{ scale: 0.97 }}
              onClick={() => startSession(s)}
              className="flex flex-col items-start gap-2 p-4 rounded-2xl bg-card border border-border hover:border-primary/50 hover:bg-primary/5 transition-all text-left">
              <span className="text-3xl">{s.emoji}</span>
              <div>
                <p className="text-sm font-semibold">{s.label}</p>
                <p className="text-[10px] text-accent mt-0.5">{s.rate}</p>
              </div>
            </motion.button>
          ))}
        </div>

        <div className="rounded-2xl bg-secondary/30 border border-border p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <Zap className="w-3.5 h-3.5 text-accent" />
            <span className="text-xs font-semibold text-accent">Perun State Channel</span>
          </div>
          <p className="text-xs text-muted-foreground">
            선택 즉시 5 USDC가 에스크로에 예치되고 실시간 마이크로페이먼트 채널이 열립니다.
          </p>
        </div>
      </div>
      <BottomNav />
    </div>
  );

  // ── SCANNING ──────────────────────────────────────────────────────────────
  if (step === "scanning") return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center">
      <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ repeat: Infinity, duration: 1.4 }}
        className="w-24 h-24 rounded-full bg-primary/10 border-2 border-primary/30 flex items-center justify-center mb-6">
        <span className="text-4xl">{selectedService?.emoji}</span>
      </motion.div>
      <p className="text-lg font-semibold mb-1">채널 오픈 중...</p>
      <p className="text-sm text-muted-foreground mb-4">{selectedService?.label}</p>
      <div className="flex gap-1.5">
        {[0, 1, 2].map(i => (
          <motion.div key={i} className="w-2 h-2 rounded-full bg-primary"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ repeat: Infinity, duration: 1, delay: i * 0.2 }} />
        ))}
      </div>
    </div>
  );

  // ── ACTIVE ────────────────────────────────────────────────────────────────
  if (step === "active") return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <p className="text-xs text-muted-foreground">진행 중</p>
            <h1 className="text-lg font-semibold">{selectedService?.emoji} {selectedService?.label}</h1>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-accent/10 border border-accent/20">
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span className="text-xs font-medium text-accent">LIVE</span>
          </div>
        </div>

        {/* 타이머 */}
        <div className="rounded-2xl bg-card border border-border p-8 text-center mb-4">
          <p className="text-xs text-muted-foreground mb-2">경과 시간</p>
          <p className="text-6xl font-bold font-mono tracking-tight text-primary">{fmt(elapsed)}</p>
          {fareInfo && (
            <p className="text-sm text-accent mt-3 font-medium">{fareInfo.fareUsdc} USDC 청구됨</p>
          )}
          <p className="text-xs text-muted-foreground mt-2">예치금 5.0 USDC · Perun 채널 활성</p>
        </div>

        {/* 세션 정보 */}
        <div className="rounded-2xl bg-secondary/30 border border-border p-4 mb-4 space-y-2 text-sm font-mono">
          {[
            ["세션 ID", sessionData?.sessionId?.slice(0, 16) + "..."],
            ["채널 ID", sessionData?.channelId || "-"],
            ["네트워크", "Base Sepolia"],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between items-center">
              <span className="text-muted-foreground">{k}</span>
              <span className={k === "네트워크" ? "text-accent text-xs" : "text-xs"}>{v}</span>
            </div>
          ))}
        </div>

        {/* 버튼 */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <Button variant="outline" onClick={chargeSession}
            className="h-12 rounded-xl border-yellow-500/30 text-yellow-400 hover:bg-yellow-500/10">
            💰 요금 청구
          </Button>
          <Button onClick={endSession}
            className="h-12 rounded-xl bg-destructive hover:bg-destructive/90">
            🏁 세션 종료
          </Button>
        </div>

        {/* 로그 */}
        {log.length > 0 && (
          <div className="rounded-2xl bg-card border border-border p-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">로그</p>
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              {log.map((l, i) => (
                <div key={i} className={`flex gap-2 text-xs ${
                  l.type === "error" ? "text-destructive" :
                  l.type === "success" ? "text-accent" : "text-muted-foreground"
                }`}>
                  <span className="text-muted-foreground/50 shrink-0">{l.ts}</span>
                  <span>{l.msg}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <BottomNav />
    </div>
  );

  // ── ENDED ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 15 }}
        className="w-20 h-20 rounded-full bg-accent/10 flex items-center justify-center mb-6">
        <CheckCircle2 className="w-10 h-10 text-accent" />
      </motion.div>
      <h2 className="text-2xl font-bold mb-2">정산 완료!</h2>
      <p className="text-sm text-muted-foreground mb-6 text-center">
        {selectedService?.label} · {fmt(elapsed)} 이용 · Perun 채널 정산
      </p>

      <div className="w-full max-w-sm rounded-2xl bg-card border border-border p-5 mb-8 space-y-3 text-sm font-mono">
        {[
          ["세션 ID",  sessionData?.sessionId?.slice(0, 16) + "..."],
          ["채널 ID",  sessionData?.channelId],
          ["이용 시간", fmt(elapsed)],
          ["청구 금액", fareInfo ? `${fareInfo.fareUsdc} USDC` : "계산 중..."],
          ["체인",     "Base Sepolia"],
        ].map(([k, v]) => v && (
          <div key={k} className="flex justify-between border-b border-border pb-2 last:border-0 last:pb-0">
            <span className="text-muted-foreground">{k}</span>
            <span className={k === "청구 금액" ? "text-accent" : "text-foreground"}>{v}</span>
          </div>
        ))}
      </div>

      <Button onClick={reset} className="rounded-xl px-8 bg-primary hover:bg-primary/90">
        새 결제 시작
      </Button>
      <BottomNav />
    </div>
  );
}
