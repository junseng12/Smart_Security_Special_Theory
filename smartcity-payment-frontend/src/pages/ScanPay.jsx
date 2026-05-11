import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { CheckCircle2, Zap, AlertCircle, ArrowLeft, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BottomNav from '@/components/wallet/BottomNav';
import { approveUsdcForEscrow, userDeposit, getUsdcBalance, ESCROW_V3_ADDRESS, OPERATOR_ADDRESS } from '@/lib/walletUtils';

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

function saveSession(service, sessionData, startedAt) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ service, sessionData, startedAt }));
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}
function loadSession() {
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
        if (startedAtRef.current) {
          setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
        } else {
          setElapsed(e => e + 1);
        }
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

  const startSession = async (service) => {
    // ── 세션 중복 차단 ──
    const existingSession = loadSession();
    if (existingSession?.sessionData) {
      setError(`이미 진행 중인 세션(${existingSession.service?.emoji} ${existingSession.service?.label})이 있습니다. 먼저 종료해주세요.`);
      return;
    }

    setSelectedService(service);
    setStep("scanning");
    setError(null);
    addLog(`QR 스캔: ${service.serviceId}`, "info");

    try {
      // 1) USDC approve
      addLog(`🔓 MetaMask에서 USDC approve 요청 중...`, "info");
      const approveTxHash = await approveUsdcForEscrow(mmAddress, ESCROW_V3_ADDRESS, service.depositUsdc);
      addLog(`✅ Approve 완료 — ${approveTxHash.slice(0, 16)}...`, "success");

      // 2) 백엔드 세션 시작 (escrowId, holdDeadline 수신)
      const data = await apiCall("/api/v1/sessions/start", "POST", {
        userAddress: mmAddress,
        serviceType: service.id,
        depositUsdc: String(service.depositUsdc),
      });

      // 3) 에스크로 V3 userDeposit 온체인 호출
      const escrowId = data.escrowId || data.sessionId;
      const holdDeadline = data.holdDeadline
        ? Math.floor(new Date(data.holdDeadline).getTime() / 1000)
        : Math.floor(Date.now() / 1000) + 3600;
      addLog(`💳 MetaMask에서 ${service.depositUsdc} USDC userDeposit 요청 중...`, "info");
      const txHash = await userDeposit(mmAddress, escrowId, OPERATOR_ADDRESS, service.depositUsdc, holdDeadline);
      setDepositTxHash(txHash);
      addLog(`✅ 온체인 예치 완료 — ${txHash.slice(0, 16)}...`, "success");

      // 4) 백엔드 deposit 기록
      try {
        await apiCall(`/api/v1/sessions/${data.sessionId}/deposit`, "POST", {
          channelId:       data.channelId,
          userAddress:     mmAddress,
          operatorAddress: OPERATOR_ADDRESS,
          depositUsdc:     String(service.depositUsdc),
          holdDeadline,
          depositTxHash:   txHash,
        });
      } catch (e) {
        addLog(`⚠️ deposit 기록 실패 (계속 진행): ${e.message}`, "error");
      }

      const now = Date.now();
      startedAtRef.current = now;
      setSessionData(data);
      saveSession(service, data, now, txHash);
      setStep("active");
      addLog(`✅ 세션 시작 — ${data.sessionId?.slice(0, 12)}...`, "success");
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

      // 4) 잔액 갱신
      const newBal = await getUsdcBalance(mmAddress);
      localStorage.setItem("mm_balance", newBal);
      if (wallet) {
        await base44.entities.Wallet.update(wallet.id, { balance: newBal });
      }
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });

    } catch (e) {
      setError(e.message);
      setStep("select");
      addLog(`❌ 실패: ${e.message}`, "error");
    }
  };

  const endSession = async () => {
    if (ending) return;
    setEnding(true);
    const durationMinutes = Math.max(elapsed / 60, 0.1);

    // 1) charge — fareUsdc + stateHash + nonce + newBalances 수신
    let settlementAmount = 0;
    let chargeData = null;
    let userFinalSig = "0xmock_signature_for_demo";

    try {
      chargeData = await apiCall(`/api/v1/sessions/${sessionData.sessionId}/charge`, "POST", {
        channelId: sessionData.channelId,
        userAddress: mmAddress,
        serviceType: selectedService.id,
        usage: { durationMinutes },
      });
      const rawFare =
        chargeData.fare_amount ??
        chargeData.fare?.fareUsdc ??
        chargeData.fareUsdc ??
        "0";
      settlementAmount = parseFloat(rawFare);
      setFareInfo(chargeData.fare ?? { fareUsdc: rawFare });
      addLog(`💰 요금 계산: ${rawFare} USDC`, "success");
    } catch (e) {
      addLog(`⚠️ 요금 계산 실패 (계속 진행): ${e.message}`, "error");
    }

    // 2) MetaMask 실서명 (stateHash가 있을 때만)
    // signatureRequest 안에 stateHash가 있음 (백엔드 charge 응답 구조 맞춤)
    const stateHash = chargeData?.signatureRequest?.stateHash
                   ?? chargeData?.stateHash
                   ?? chargeData?.state_hash
                   ?? null;
    const sigNonce       = chargeData?.signatureRequest?.nonce       ?? chargeData?.nonce;
    const sigNewBalances = chargeData?.signatureRequest?.newBalances  ?? chargeData?.newBalances;
    if (stateHash && window.ethereum) {
      try {
        addLog(`✍️ MetaMask에서 채널 상태 서명 요청 중...`, "info");
        userFinalSig = await window.ethereum.request({
          method: "personal_sign",
          params: [stateHash, mmAddress],
        });
        addLog(`✅ 서명 완료`, "success");

        // 3) /sign API — 채널 state 서명 확정
        try {
          await apiCall(`/api/v1/sessions/${sessionData.sessionId}/sign`, "POST", {
            channelId: sessionData.channelId,
            userAddress: mmAddress,
            stateHash,
            nonce: sigNonce,
            newBalances: sigNewBalances,
            userSig: userFinalSig,
          });
          addLog(`🔏 채널 상태 서명 확정`, "success");
        } catch (e) {
          addLog(`⚠️ /sign API 실패 (계속 진행): ${e.message}`, "error");
        }
      } catch (e) {
        addLog(`⚠️ MetaMask 서명 거부 — mock 서명으로 진행`, "error");
        userFinalSig = "0xmock_signature_for_demo";
      }
    }

    // 4) 백엔드 세션 종료 — 실서명 + fareUsdc 전달
    try {
      const endData = await apiCall(`/api/v1/sessions/${sessionData.sessionId}/end`, "POST", {
        channelId: sessionData.channelId,
        userAddress: mmAddress,
        userFinalSig,
        fareUsdc: String(settlementAmount),
      });
      addLog(`🏁 백엔드 세션 종료 완료`, "success");

      // 요금 우선순위: 1) escrow_locks.fare_amount, 2) settlements.operator_earn_usdc, 3) chargeData
      const settledFare =
        endData?.fare_amount ??
        endData?.settlement?.operator_earn_usdc ??
        endData?.escrow?.fareUsdc ??
        null;
      if (settledFare !== null && parseFloat(settledFare) > 0) {
        settlementAmount = parseFloat(settledFare);
        setFareInfo(prev => ({ ...(prev ?? {}), fareUsdc: String(settledFare) }));
        addLog(`✅ 최종 정산 요금: ${settledFare} USDC`, "success");
      }

      if (endData?.escrow?.txHash) {
        addLog(`🔐 에스크로 잠금 완료 → ${endData.escrow.txHash.slice(0,14)}...`, "success");
        addLog(`⏳ ${Math.round((new Date(endData.escrow.holdDeadline) - Date.now()) / 1000)}초 후 서비스 제공자에게 자동 정산`, "info");
      }
    } catch (e) {
      addLog(`⚠️ 세션 종료 API 오류 (로컬 정산 진행): ${e.message}`, "error");
    }

    // 3) DB 기록
    try {
      await base44.entities.Transaction.create({
        type: 'payment',
        amount: settlementAmount,
        status: 'completed',
        to_address: selectedService.serviceId,
        from_address: mmAddress,
        merchant_name: `${selectedService.emoji} ${selectedService.label}`,
        tx_hash: sessionData.sessionId,
        wallet_id: wallet?.id,
      });

      // 4) 잔액 갱신 (온체인 실제 잔액 기준)
      const newBal = await getUsdcBalance(mmAddress);
      localStorage.setItem("mm_balance", newBal);
      if (wallet) {
        await base44.entities.Wallet.update(wallet.id, { balance: newBal });
      }
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    } catch (e) {
      addLog(`⚠️ DB 기록 오류: ${e.message}`, "error");
    }

    clearSession();
    setEnding(false);
    setStep("ended");
    addLog(`🏁 정산 완료!`, "success");
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
      <Button onClick={() => navigate('/')} className="rounded-xl px-6">
        홈으로 돌아가기
      </Button>
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
            <p className="text-xs text-muted-foreground">서비스를 선택하면 MetaMask에서 USDC 전송이 요청됩니다</p>
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
          {SERVICE_TYPES.map(s => (
            <motion.button key={s.id} whileTap={{ scale: 0.97 }} onClick={() => startSession(s)}
              className="flex flex-col items-start gap-2 p-4 rounded-2xl bg-card border border-border hover:border-primary/30 hover:bg-primary/5 transition-all text-left">
              <span className="text-3xl">{s.emoji}</span>
              <div>
                <p className="text-sm font-semibold">{s.label}</p>
                <p className="text-[10px] text-primary mt-0.5">{s.rate}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">예치금 {s.depositUsdc} USDC</p>
                <p className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">{s.serviceId}</p>
              </div>
            </motion.button>
          ))}
        </div>
        <div className="rounded-2xl bg-secondary/30 border border-border p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <Zap className="w-3.5 h-3.5 text-primary" />
            <span className="text-xs font-semibold text-primary">Perun State Channel</span>
          </div>
          <p className="text-xs text-muted-foreground">선택 즉시 MetaMask에서 USDC 예치 트랜잭션이 요청됩니다. 가스비(ETH)가 필요합니다.</p>
        </div>
      </div>
      <BottomNav />
    </div>
  );

  // ── SCANNING ────────────────────────────────────────────────────────────────
  if (step === "scanning") return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
      <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ repeat: Infinity, duration: 1.4 }}
        className="w-24 h-24 rounded-full bg-primary/10 border-2 border-primary/30 flex items-center justify-center mb-6">
        <span className="text-4xl">{selectedService?.emoji}</span>
      </motion.div>
      <p className="text-lg font-semibold mb-1">채널 오픈 중...</p>
      <p className="text-sm text-muted-foreground mb-1">{selectedService?.label}</p>
      <p className="text-xs font-mono text-muted-foreground mb-4">{selectedService?.serviceId}</p>
      <p className="text-xs text-yellow-400 text-center mb-6">MetaMask 팝업에서 USDC 전송을 승인해주세요</p>
      <div className="flex gap-1.5">
        {[0, 1, 2].map(i => (
          <motion.div key={i} className="w-2 h-2 rounded-full bg-primary"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ repeat: Infinity, duration: 1, delay: i * 0.2 }} />
        ))}
      </div>
    </div>
  );

  // ── ACTIVE ──────────────────────────────────────────────────────────────────
  if (step === "active") return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <p className="text-xs text-muted-foreground">진행 중</p>
            <h1 className="text-lg font-semibold">{selectedService?.emoji} {selectedService?.label}</h1>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-primary/10 border border-primary/20">
            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            <span className="text-xs font-medium text-primary">LIVE</span>
          </div>
        </div>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl bg-card border border-border p-8 text-center mb-4">
          <p className="text-xs text-muted-foreground mb-2">경과 시간</p>
          <p className="text-6xl font-bold font-mono tracking-tight text-primary">{fmt(elapsed)}</p>
          <p className="text-xs text-muted-foreground mt-3">
            예치금 {selectedService?.depositUsdc} USDC · Perun 채널 활성
          </p>
          {fareInfo && (
            <p className="text-sm font-semibold text-primary mt-2">현재 요금: {fareInfo.fareUsdc} USDC</p>
          )}
        </motion.div>
        <div className="rounded-2xl bg-secondary/30 border border-border p-4 mb-4 space-y-2 text-sm font-mono">
          <div className="flex justify-between">
            <span className="text-muted-foreground">세션 ID</span>
            <span className="text-primary text-xs">{sessionData?.sessionId?.slice(0, 16)}...</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">채널 ID</span>
            <span className="text-xs">{sessionData?.channelId ? sessionData.channelId.slice(0, 16) + "..." : "생성 중..."}</span>
          </div>
          {depositTxHash && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">예치 Tx</span>
              <a
                href={`https://sepolia.basescan.org/tx/${depositTxHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline"
              >
                {depositTxHash.slice(0, 14)}...↗
              </a>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-muted-foreground">네트워크</span>
            <span className="text-primary text-xs">Base Sepolia</span>
          </div>
        </div>
        <Button
          onClick={endSession}
          disabled={ending}
          className="w-full h-12 rounded-xl bg-destructive hover:bg-destructive/90 disabled:opacity-60"
        >
          {ending ? (
            <><Loader2 className="w-4 h-4 animate-spin mr-2" />정산 중...</>
          ) : "🏁 세션 종료"}
        </Button>
        {log.length > 0 && (
          <div className="rounded-2xl bg-card border border-border p-4 mt-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">로그</p>
            <div className="space-y-1.5 max-h-36 overflow-y-auto">
              {log.map((l, i) => (
                <div key={i} className={`flex gap-2 text-xs ${
                  l.type === "error" ? "text-destructive" :
                  l.type === "success" ? "text-primary" : "text-muted-foreground"
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

  // ── ENDED ───────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
      <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200, damping: 15 }}
        className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
        <CheckCircle2 className="w-10 h-10 text-primary" />
      </motion.div>
      <h2 className="text-2xl font-bold mb-2">정산 완료!</h2>
      <p className="text-sm text-muted-foreground mb-6 text-center">
        {selectedService?.label} · {fmt(elapsed)} 이용 · Perun 채널 정산
      </p>
      <div className="w-full max-w-sm rounded-2xl bg-card border border-border p-5 mb-8 space-y-3 text-sm font-mono">
        {[
          ["세션 ID", sessionData?.sessionId?.slice(0, 16) + "..."],
          ["채널 ID", sessionData?.channelId ? sessionData.channelId.slice(0, 16) + "..." : "-"],
          ["이용 시간", fmt(elapsed)],
          ["요금", fareInfo?.fareUsdc ? `${fareInfo.fareUsdc} USDC` : "-"],
          ["체인", "Base Sepolia"],
          ["정산", "Perun State Channel"],
        ].map(([k, v]) => (
          <div key={k} className="flex justify-between border-b border-border pb-2 last:border-0 last:pb-0">
            <span className="text-muted-foreground">{k}</span>
            <span className={k === "정산" || k === "요금" ? "text-primary" : "text-foreground"}>{v}</span>
          </div>
        ))}
      </div>
      {depositTxHash && (
        <a
          href={`https://sepolia.basescan.org/tx/${depositTxHash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-primary hover:underline mb-6"
        >
          BaseScan에서 예치 트랜잭션 보기 ↗
        </a>
      )}
      <Button onClick={reset} className="rounded-xl px-8 bg-primary hover:bg-primary/90">새 결제 시작</Button>
      <BottomNav />
    </div>
  );
}