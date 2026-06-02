import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import {
  approveUsdcForEscrow,
  userDeposit as escrowUserDeposit,
  getUsdcBalance,
  ESCROW_V3_ADDRESS,
} from '@/lib/walletUtils';

// ──────────────────────────────────────────────────────────────────────────────
// 상수
// ──────────────────────────────────────────────────────────────────────────────
const BACKEND          = "https://app-0c87bccf.base44.app/functions/smartcityApi";
const OPERATOR_ADDRESS = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";

const SERVICE_TYPES = [
  { id: "bicycle",     label: "공유 자전거", emoji: "🚲", depositUsdc: 3.0, serviceId: "BIKE-001" },
  { id: "ev_charging", label: "EV 충전",     emoji: "⚡", depositUsdc: 5.0, serviceId: "EV-001"  },
  { id: "parking",     label: "주차",         emoji: "🅿️", depositUsdc: 2.0, serviceId: "PARK-001"},
];

const SESSION_KEY  = "active_session";
const saveSession  = (d) => localStorage.setItem(SESSION_KEY, JSON.stringify(d));
const clearSession = ()  => localStorage.removeItem(SESSION_KEY);
const loadSession  = ()  => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } };

// ──────────────────────────────────────────────────────────────────────────────
// API 유틸
// ──────────────────────────────────────────────────────────────────────────────
async function apiCall(path, method = "GET", body = null) {
  const res = await fetch(BACKEND, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, method, body }),
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(
    data.errors?.[0] || data.error || "API Error"
  );
  return data.data ?? data;
}

// ──────────────────────────────────────────────────────────────────────────────
// 메인 컴포넌트
// ──────────────────────────────────────────────────────────────────────────────
export default function ScanPay() {
  const navigate    = useNavigate();
  const queryClient = useQueryClient();
  const mmAddress   = localStorage.getItem("mm_address");

  // ── 상태 ──
  const [step,         setStep]         = useState("select"); // select|scanning|active|ended
  const [selectedSvc,  setSelectedSvc]  = useState(null);
  const [sessionData,  setSessionData]  = useState(null);
  const [elapsed,      setElapsed]      = useState(0);
  const [totalCharged, setTotalCharged] = useState(0);
  const [fareInfo,     setFareInfo]     = useState(null);
  const [ending,       setEnding]       = useState(false);
  const [log,          setLog]          = useState([]);
  const [error,        setError]        = useState(null);

  // ── ref ──
  const sessionRef    = useRef(null);
  const serviceRef    = useRef(null);
  const startedAtRef  = useRef(null);
  const chargedMinRef = useRef(0);
  const timerRef      = useRef(null);
  const chargeRef     = useRef(null);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'], queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];

  // ── 세션 복구 ──
  useEffect(() => {
    const saved = loadSession();
    if (saved?.sessionData && saved?.service) {
      const elapsedSec = Math.floor((Date.now() - saved.startedAt) / 1000);
      setSelectedSvc(saved.service);
      setSessionData(saved.sessionData);
      sessionRef.current    = saved.sessionData;
      serviceRef.current    = saved.service;
      startedAtRef.current  = saved.startedAt;
      chargedMinRef.current = Math.floor(elapsedSec / 60);
      setElapsed(elapsedSec);
      setStep("active");
    }
  }, []);

  // ── 경과시간 타이머 ──
  useEffect(() => {
    if (step !== "active") { clearInterval(timerRef.current); return; }
    timerRef.current = setInterval(() => {
      if (startedAtRef.current)
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [step]);

  // ── 60초 Perun 오프체인 charge 타이머 ──
  useEffect(() => {
    if (step !== "active") { clearInterval(chargeRef.current); return; }
    chargeRef.current = setInterval(async () => {
      const sd  = sessionRef.current;
      const svc = serviceRef.current;
      if (!sd || !svc || !mmAddress) return;
      const minutesSoFar = Math.floor((Date.now() - startedAtRef.current) / 60000);
      if (minutesSoFar <= chargedMinRef.current) return;
      const durationMinutes = minutesSoFar - chargedMinRef.current;
      try {
        const chargeData = await apiCall(`/api/v1/sessions/${sd.sessionId}/charge`, "POST", {
          channelId: sd.channelId, userAddress: mmAddress,
          serviceType: svc.id, usage: { durationMinutes },
        });
        const fare = parseFloat(chargeData.fare?.fareUsdc || "0");
        chargedMinRef.current = minutesSoFar;
        setTotalCharged(prev => prev + fare);
        setFareInfo(chargeData.fare);
        addLog(`⚡ [${minutesSoFar}분] 오프체인 차감 ${chargeData.fare?.fareUsdc} USDC`, "info");
      } catch (e) { addLog(`⚠️ charge 오류: ${e.message}`, "error"); }
    }, 60_000);
    return () => clearInterval(chargeRef.current);
  }, [step, mmAddress]);

  const addLog = (msg, type = "info") =>
    setLog(prev => [...prev.slice(-25), { msg, type, ts: new Date().toLocaleTimeString() }]);

  const fmt = (s) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // ────────────────────────────────────────────────────────────────────────────
  // ★ 세션 시작 — V3 Escrow 정상 흐름
  //   1) 백엔드 /start → sessionId + escrowId + holdDeadline (2분)
  //   2) MetaMask approve → 에스크로 컨트랙트에 USDC 지출 허가
  //   3) MetaMask userDeposit() → 에스크로 컨트랙트에 USDC 잠금
  //   4) 백엔드 /deposit → DB 기록 + 자동 operatorDeposit 트리거
  // ────────────────────────────────────────────────────────────────────────────
  const startSession = async (svc) => {
    const saved = loadSession();
    if (saved?.sessionData) {
      setError(`이미 진행 중인 세션(${saved.service?.emoji} ${saved.service?.label})이 있습니다.`);
      return;
    }
    setSelectedSvc(svc);
    serviceRef.current = svc;
    setStep("scanning");
    setError(null);
    chargedMinRef.current = 0;
    setTotalCharged(0);

    try {
      // STEP 1: 백엔드 세션 생성
      addLog("🔧 백엔드 세션 생성 중...", "info");
      const startData = await apiCall("/api/v1/sessions/start", "POST", {
        userAddress: mmAddress,
        serviceType: svc.id,
        depositUsdc: String(svc.depositUsdc),
      });
      const { sessionId, channelId, escrowId, holdDeadline } = startData;
      addLog(`✅ 세션 생성 완료 — ${sessionId.slice(0, 12)}...`, "success");

      if (!escrowId || !holdDeadline)
        throw new Error("백엔드 응답에 escrowId / holdDeadline이 없습니다.");

      // STEP 2: MetaMask approve
      addLog(`🦊 MetaMask: USDC approve ${svc.depositUsdc} USDC...`, "info");
      const approveTxHash = await approveUsdcForEscrow(mmAddress, ESCROW_V3_ADDRESS, svc.depositUsdc);
      addLog(`✅ approve TX: ${approveTxHash.slice(0, 16)}...`, "success");
      addLog("⏳ approve 컨펌 대기 (6초)...", "info");
      await new Promise(r => setTimeout(r, 6000));

      // STEP 3: MetaMask userDeposit
      addLog(`🦊 MetaMask: 에스크로 예치 ${svc.depositUsdc} USDC...`, "info");
      const depositTxHash = await escrowUserDeposit(
        mmAddress, escrowId, OPERATOR_ADDRESS, svc.depositUsdc, holdDeadline,
      );
      addLog(`✅ userDeposit TX: ${depositTxHash.slice(0, 16)}...`, "success");
      addLog("⏳ deposit 컨펌 대기 (6초)...", "info");
      await new Promise(r => setTimeout(r, 6000));

      // STEP 4: 백엔드 /deposit 기록
      addLog("🔧 백엔드 예치 기록 + operator 자동 예치 중...", "info");
      await apiCall(`/api/v1/sessions/${sessionId}/deposit`, "POST", {
        channelId, userAddress: mmAddress,
        operatorAddress: OPERATOR_ADDRESS,
        depositUsdc: String(svc.depositUsdc),
        holdDeadline, depositTxHash,
      });
      addLog("✅ 에스크로 FullyFunded! 서비스 시작됩니다.", "success");

      const now = Date.now();
      startedAtRef.current = now;
      sessionRef.current   = startData;
      setSessionData(startData);
      saveSession({ service: svc, sessionData: startData, startedAt: now });
      setStep("active");

      await base44.entities.Transaction.create({
        type: 'session_start', amount: svc.depositUsdc, status: 'active',
        to_address: ESCROW_V3_ADDRESS, from_address: mmAddress,
        merchant_name: `${svc.emoji} ${svc.label}`,
        tx_hash: depositTxHash, wallet_id: wallet?.id,
        note: `세션ID: ${sessionId}`,
      }).catch(() => {});

      const newBal = await getUsdcBalance(mmAddress).catch(() => null);
      if (newBal !== null) {
        localStorage.setItem("mm_balance", newBal);
        if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: newBal }).catch(() => {});
        queryClient.invalidateQueries({ queryKey: ['wallets'] });
      }
    } catch (e) {
      setError(e.message);
      setStep("select");
      addLog(`❌ 실패: ${e.message}`, "error");
    }
  };

  // ────────────────────────────────────────────────────────────────────────────
  // ★ 세션 종료 — 정산 흐름
  //   1) 마지막 남은 시간 /charge
  //   2) /end → 백엔드가 holdDeadline(2분) 이후 settleAndRelease 자동 호출
  //      → 컨트랙트: fare → operator, (deposit - fare) → user 자동 환불
  // ────────────────────────────────────────────────────────────────────────────
  const endSession = async () => {
    if (ending) return;
    setEnding(true);
    clearInterval(chargeRef.current);
    clearInterval(timerRef.current);

    const sd  = sessionRef.current;
    const svc = serviceRef.current;
    const totalElapsedMin = Math.max(elapsed / 60, 0.1);
    let finalFareUsdc = 0;

    try {
      const remainMin = totalElapsedMin - chargedMinRef.current;
      if (remainMin > 0.05) {
        const chargeData = await apiCall(`/api/v1/sessions/${sd.sessionId}/charge`, "POST", {
          channelId: sd.channelId, userAddress: mmAddress,
          serviceType: svc.id, usage: { durationMinutes: remainMin },
        });
        finalFareUsdc = parseFloat(chargeData.fare?.fareUsdc || "0");
        setFareInfo(chargeData.fare);
        addLog(`💰 최종 요금: ${chargeData.fare?.fareUsdc} USDC`, "success");
      } else {
        finalFareUsdc = 0;
        addLog(`💰 누적 요금: ${totalCharged.toFixed(4)} USDC`, "success");
      }
    } catch (e) {
      addLog(`⚠️ 최종 요금 계산 실패: ${e.message}`, "error");
    }

    const totalFare  = totalCharged + finalFareUsdc;
    const refundUsdc = Math.max(0, (svc?.depositUsdc || 0) - totalFare);

    try {
      await apiCall(`/api/v1/sessions/${sd.sessionId}/end`, "POST", {
        channelId:    sd.channelId,
        userAddress:  mmAddress,
        userFinalSig: "0xmock_signature_for_demo",
        fareUsdc:     totalFare.toFixed(6),
      });
      addLog("🏁 정산 요청 완료 — holdDeadline(2분) 이후 자동 온체인 정산", "success");
      addLog(`📤 요금 ${totalFare.toFixed(4)} USDC → operator`, "info");
      addLog(`📥 환불 ${refundUsdc.toFixed(4)} USDC → 내 지갑 (약 2분 후)`, "success");
    } catch (e) {
      addLog(`⚠️ /end 오류: ${e.message}`, "error");
    }

    await base44.entities.Transaction.create({
      type: 'payment', amount: totalFare, status: 'completed',
      to_address: svc?.serviceId, from_address: mmAddress,
      merchant_name: `${svc?.emoji} ${svc?.label}`,
      tx_hash: sd?.sessionId, wallet_id: wallet?.id,
    }).catch(() => {});

    // 3분 후 온체인 잔액 갱신 (settleAndRelease 완료 후)
    setTimeout(async () => {
      const newBal = await getUsdcBalance(mmAddress).catch(() => null);
      if (newBal !== null) {
        localStorage.setItem("mm_balance", newBal);
        if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: newBal }).catch(() => {});
        queryClient.invalidateQueries({ queryKey: ['wallets'] });
      }
    }, 180_000);

    clearSession();
    setEnding(false);
    setStep("ended");
  };

  const reset = () => {
    clearSession();
    startedAtRef.current  = null; sessionRef.current  = null;
    serviceRef.current    = null; chargedMinRef.current = 0;
    setStep("select"); setSelectedSvc(null); setSessionData(null);
    setElapsed(0); setLog([]); setError(null); setFareInfo(null); setTotalCharged(0);
  };

  // ────────────────────────────────────────────────────────────────────────────
  // 렌더
  // ────────────────────────────────────────────────────────────────────────────
  if (!mmAddress) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
        <div className="text-4xl mb-4">🦊</div>
        <h2 className="text-xl font-bold mb-2">MetaMask 연결 필요</h2>
        <p className="text-gray-500 mb-6">결제를 위해 먼저 MetaMask를 연결해주세요.</p>
        <button onClick={() => navigate('/profile')}
          className="bg-blue-600 text-white px-6 py-3 rounded-xl font-semibold">
          프로필에서 연결
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      {/* 헤더 */}
      <div className="bg-white border-b px-4 py-4 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
        <button onClick={() => navigate(-1)} className="text-gray-500 hover:text-gray-700 p-1">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <div>
          <h1 className="text-lg font-bold text-gray-900">QR 결제</h1>
          <p className="text-xs text-gray-500">Perun 오프체인 마이크로페이먼트 · V3 Escrow</p>
        </div>
      </div>

      <div className="px-4 py-6 space-y-4 max-w-md mx-auto">

        {/* ── 서비스 선택 ── */}
        {step === "select" && (
          <div className="space-y-4">
            <div className="bg-blue-50 rounded-xl p-3 text-xs text-blue-700">
              💡 서비스 선택 시 MetaMask로 USDC를 에스크로 컨트랙트에 예치합니다.<br/>
              사용 후 종료하면 요금을 제외한 잔액이 약 2분 후 자동 환불됩니다.
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
                ⚠️ {error}
              </div>
            )}
            <h2 className="text-base font-bold text-gray-800">서비스를 선택하세요</h2>
            {SERVICE_TYPES.map(svc => (
              <button key={svc.id} onClick={() => startSession(svc)}
                className="w-full bg-white rounded-2xl p-5 shadow-sm border border-gray-100 flex items-center gap-4 hover:border-blue-300 hover:shadow-md transition-all text-left">
                <div className="text-4xl">{svc.emoji}</div>
                <div className="flex-1">
                  <div className="font-bold text-gray-900">{svc.label}</div>
                  <div className="text-sm text-gray-500">예치금 {svc.depositUsdc} USDC · 사용 후 잔액 자동 환불</div>
                </div>
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
                </svg>
              </button>
            ))}
          </div>
        )}

        {/* ── 처리 중 ── */}
        {step === "scanning" && (
          <div className="bg-white rounded-2xl p-8 shadow-sm text-center space-y-4">
            <div className="text-5xl animate-pulse">📡</div>
            <h2 className="text-xl font-bold">처리 중...</h2>
            <p className="text-gray-500 text-sm">MetaMask에서 단계별로 승인해주세요</p>
            <div className="text-xs text-gray-400 bg-gray-50 rounded-lg p-3 text-left space-y-1">
              <div>① 백엔드 세션 생성</div>
              <div>② MetaMask: USDC approve 서명</div>
              <div>③ MetaMask: 에스크로 예치(userDeposit) 서명</div>
              <div>④ 백엔드 예치 기록 완료</div>
            </div>
          </div>
        )}

        {/* ── 세션 활성 ── */}
        {step === "active" && selectedSvc && (
          <>
            <div className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl p-6 text-white shadow-lg">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">{selectedSvc.emoji}</span>
                  <div>
                    <div className="font-bold text-lg">{selectedSvc.label}</div>
                    <div className="text-blue-200 text-sm">이용 중 · Perun 오프체인 활성</div>
                  </div>
                </div>
                <div className="bg-white/20 rounded-xl px-3 py-2 text-center">
                  <div className="text-xs text-blue-200">경과</div>
                  <div className="font-mono font-bold">{fmt(elapsed)}</div>
                </div>
              </div>
              <div className="bg-white/10 rounded-xl p-3 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-blue-200">에스크로 예치금</span>
                  <span className="font-bold">{selectedSvc.depositUsdc} USDC</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-blue-200">누적 차감 (오프체인)</span>
                  <span className="text-yellow-300 font-bold">− {totalCharged.toFixed(4)} USDC</span>
                </div>
                <div className="border-t border-white/20 pt-2 flex justify-between">
                  <span className="text-blue-200">예상 환불액</span>
                  <span className="text-green-300 font-bold text-base">
                    ≈ {Math.max(0, selectedSvc.depositUsdc - totalCharged).toFixed(4)} USDC
                  </span>
                </div>
              </div>
            </div>

            {sessionData && (
              <div className="bg-white rounded-2xl p-4 shadow-sm text-xs text-gray-400 space-y-1">
                <div className="flex justify-between">
                  <span>세션 ID</span><span className="font-mono">{sessionData.sessionId?.slice(0,20)}...</span>
                </div>
                <div className="flex justify-between">
                  <span>escrowId</span><span className="font-mono">{sessionData.escrowId?.slice(0,20)}...</span>
                </div>
                <div className="flex justify-between">
                  <span>holdDeadline</span>
                  <span className="font-mono">
                    {sessionData.holdDeadline
                      ? new Date(sessionData.holdDeadline * 1000).toLocaleTimeString()
                      : '-'}
                  </span>
                </div>
              </div>
            )}

            {fareInfo && (
              <div className="bg-white rounded-2xl p-4 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-700 mb-2">💡 최근 요금</h3>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="bg-gray-50 rounded-xl p-3">
                    <div className="text-gray-400 text-xs">단가</div>
                    <div className="font-bold">{fareInfo.ratePerMin ?? fareInfo.ratePerKwh ?? '-'} USDC/분</div>
                  </div>
                  <div className="bg-blue-50 rounded-xl p-3">
                    <div className="text-blue-400 text-xs">이번 청구</div>
                    <div className="font-bold text-blue-700">{fareInfo.fareUsdc} USDC</div>
                  </div>
                </div>
              </div>
            )}

            <button onClick={endSession} disabled={ending}
              className="w-full bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white font-bold py-4 rounded-2xl shadow transition-all text-lg">
              {ending ? "⏳ 정산 중..." : "🏁 서비스 종료 & 정산"}
            </button>
          </>
        )}

        {/* ── 종료 완료 ── */}
        {step === "ended" && (
          <div className="bg-white rounded-2xl p-8 shadow-sm text-center space-y-4">
            <div className="text-6xl">✅</div>
            <h2 className="text-2xl font-bold">정산 완료</h2>
            {selectedSvc && (
              <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm text-left">
                <div className="flex justify-between">
                  <span className="text-gray-500">서비스</span>
                  <span className="font-semibold">{selectedSvc.emoji} {selectedSvc.label}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">이용 시간</span>
                  <span className="font-semibold">{fmt(elapsed)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">예치금</span>
                  <span className="font-semibold">{selectedSvc.depositUsdc} USDC</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">총 요금</span>
                  <span className="font-bold text-red-600">
                    − {(totalCharged + parseFloat(fareInfo?.fareUsdc || 0)).toFixed(4)} USDC
                  </span>
                </div>
                <div className="border-t pt-2 flex justify-between">
                  <span className="font-semibold text-gray-700">환불 예정</span>
                  <span className="font-bold text-green-600 text-base">
                    + {Math.max(0, selectedSvc.depositUsdc - totalCharged - parseFloat(fareInfo?.fareUsdc || 0)).toFixed(4)} USDC
                  </span>
                </div>
              </div>
            )}
            <div className="bg-green-50 rounded-xl p-3 text-xs text-green-700">
              🔄 온체인 환불은 약 2분 후 MetaMask 지갑에 자동 입금됩니다.
            </div>
            <button onClick={reset}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-3 rounded-xl transition-all">
              다시 이용하기
            </button>
          </div>
        )}

        {/* ── 이벤트 로그 ── */}
        {log.length > 0 && (
          <div className="bg-white rounded-2xl p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">📋 이벤트 로그</h3>
            <div className="space-y-1 max-h-52 overflow-y-auto">
              {log.slice().reverse().map((l, i) => (
                <div key={i} className={`text-xs flex gap-2 ${
                  l.type === 'error'   ? 'text-red-500' :
                  l.type === 'success' ? 'text-green-600' : 'text-gray-500'
                }`}>
                  <span className="text-gray-300 shrink-0">{l.ts}</span>
                  <span>{l.msg}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
