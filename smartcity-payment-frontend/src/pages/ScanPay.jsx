import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { sendUsdcOnChain, getUsdcBalance } from '@/lib/walletUtils';

const BACKEND = "https://smartcity-payment-backend-production.up.railway.app";
const ESCROW_ADDRESS = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";

async function apiCall(path, method = "GET", body = null) {
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.ok && data.error) throw new Error(data.error);
  if (!data.ok && data.errors) throw new Error(data.errors.join(', '));
  return data.data ?? data;
}

const SERVICE_TYPES = [
  { id: "bicycle",    label: "공유 자전거", emoji: "🚲", depositUsdc: 3.0,  serviceId: "BIKE-001" },
  { id: "ev_charging",label: "EV 충전",    emoji: "⚡", depositUsdc: 5.0,  serviceId: "EV-001" },
  { id: "parking",    label: "주차",        emoji: "🅿️", depositUsdc: 2.0,  serviceId: "PARK-001" },
];

const SESSION_KEY = "active_session";
function saveSession(service, sessionData, startedAt) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ service, sessionData, startedAt }));
}
function clearSession() { localStorage.removeItem(SESSION_KEY); }
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

export default function ScanPay() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState("select");
  const [selectedService, setSelectedService] = useState(null);
  const [sessionData, setSessionData] = useState(null);
  const [elapsed, setElapsed] = useState(0);           // 경과 초
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [fareInfo, setFareInfo] = useState(null);
  const [ending, setEnding] = useState(false);
  const [totalCharged, setTotalCharged] = useState(0); // 누적 Perun charge 합계

  const timerRef      = useRef(null);  // 경과시간 타이머 (1초)
  const chargeRef     = useRef(null);  // Perun charge 타이머 (60초)
  const startedAtRef  = useRef(null);
  const sessionRef    = useRef(null);  // 최신 sessionData 참조 (클로저 문제 방지)
  const serviceRef    = useRef(null);
  const chargedMinRef = useRef(0);     // 이미 charge 호출한 누적 분

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'], queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet    = wallets[0];
  const mmAddress = localStorage.getItem("mm_address");

  // 저장된 세션 복구
  useEffect(() => {
    const saved = loadSession();
    if (saved?.sessionData && saved?.service) {
      const elapsedSec = Math.floor((Date.now() - saved.startedAt) / 1000);
      setSelectedService(saved.service);
      setSessionData(saved.sessionData);
      sessionRef.current  = saved.sessionData;
      serviceRef.current  = saved.service;
      startedAtRef.current = saved.startedAt;
      chargedMinRef.current = Math.floor(elapsedSec / 60);
      setElapsed(elapsedSec);
      setStep("active");
    }
  }, []);

  // 경과시간 타이머 (1초 tick)
  useEffect(() => {
    if (step !== "active") {
      clearInterval(timerRef.current);
      return;
    }
    timerRef.current = setInterval(() => {
      if (startedAtRef.current) {
        setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [step]);

  // ★ Perun off-chain charge 타이머 (60초마다 /charge 호출)
  useEffect(() => {
    if (step !== "active") {
      clearInterval(chargeRef.current);
      return;
    }
    chargeRef.current = setInterval(async () => {
      const sd  = sessionRef.current;
      const svc = serviceRef.current;
      if (!sd || !svc || !mmAddress) return;

      // 이번 인터벌 1분분 charge
      const minutesSoFar = Math.floor((Date.now() - startedAtRef.current) / 60000);
      if (minutesSoFar <= chargedMinRef.current) return; // 이미 charge된 분은 skip

      const durationMinutes = minutesSoFar - chargedMinRef.current; // 이번에 추가된 분

      try {
        const chargeData = await apiCall(`/api/v1/sessions/${sd.sessionId}/charge`, "POST", {
          channelId:   sd.channelId,
          userAddress: mmAddress,
          serviceType: svc.id,
          usage: { durationMinutes },
        });

        const fare = chargeData.fare?.fareUsdc || "0";
        chargedMinRef.current = minutesSoFar;
        setTotalCharged(prev => prev + parseFloat(fare));
        setFareInfo(chargeData.fare);
        addLog(`⚡ [${minutesSoFar}분] 오프체인 차감 ${fare} USDC`, "info");
      } catch (e) {
        addLog(`⚠️ charge 오류: ${e.message}`, "error");
      }
    }, 60_000); // 60초마다

    return () => clearInterval(chargeRef.current);
  }, [step, mmAddress]);

  const addLog = (msg, type = "info") =>
    setLog(prev => [...prev.slice(-20), { msg, type, ts: new Date().toLocaleTimeString() }]);

  const fmt = (s) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  // ── 세션 시작 ──────────────────────────────────────────────────────────────
  const startSession = async (service) => {
    const existingSession = loadSession();
    if (existingSession?.sessionData) {
      setError(`이미 진행 중인 세션(${existingSession.service?.emoji} ${existingSession.service?.label})이 있습니다. 먼저 종료해주세요.`);
      return;
    }

    setSelectedService(service);
    serviceRef.current = service;
    setStep("scanning");
    setError(null);
    chargedMinRef.current = 0;
    setTotalCharged(0);
    addLog(`QR 스캔: ${service.serviceId}`, "info");

    try {
      // 1) MetaMask 온체인 예치
      addLog(`💳 MetaMask에서 ${service.depositUsdc} USDC 예치 승인 요청 중...`, "info");
      const txHash = await sendUsdcOnChain(mmAddress, ESCROW_ADDRESS, service.depositUsdc);
      addLog(`✅ 온체인 예치 완료 — ${txHash.slice(0, 16)}...`, "success");

      // 2) 백엔드 세션 시작 (depositTxHash 제외 — V3 스키마)
      const data = await apiCall("/api/v1/sessions/start", "POST", {
        userAddress:  mmAddress,
        serviceType:  service.id,
        depositUsdc:  String(service.depositUsdc),
      });

      const now = Date.now();
      startedAtRef.current = now;
      sessionRef.current   = data;
      setSessionData(data);
      saveSession(service, data, now);
      setStep("active");
      addLog(`✅ 세션 시작 — ${data.sessionId?.slice(0, 12)}... | 채널: ${data.channelId}`, "success");
      addLog(`📡 Perun 오프체인 채널 오픈 — 초기 잔액: ${service.depositUsdc} USDC`, "info");

      // 3) DB 기록 (session_start)
      await base44.entities.Transaction.create({
        type: 'session_start', amount: service.depositUsdc, status: 'active',
        to_address: ESCROW_ADDRESS, from_address: mmAddress,
        merchant_name: `${service.emoji} ${service.label}`, tx_hash: txHash,
        wallet_id: wallet?.id, note: `세션ID: ${data.sessionId}`,
      }).catch(() => {});

      // 4) 잔액 갱신
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

  // ── 세션 종료 ──────────────────────────────────────────────────────────────
  const endSession = async () => {
    if (ending) return;
    setEnding(true);
    clearInterval(chargeRef.current);
    clearInterval(timerRef.current);

    const sd  = sessionRef.current;
    const svc = serviceRef.current;
    const totalElapsedMin = Math.max(elapsed / 60, 0.1);

    // 1) 마지막 남은 분 charge (60초 타이머가 못 잡은 나머지)
    let finalFareUsdc = "0";
    try {
      const remainMin = totalElapsedMin - chargedMinRef.current;
      if (remainMin > 0) {
        const chargeData = await apiCall(`/api/v1/sessions/${sd.sessionId}/charge`, "POST", {
          channelId:   sd.channelId,
          userAddress: mmAddress,
          serviceType: svc.id,
          usage: { durationMinutes: remainMin },
        });
        finalFareUsdc = chargeData.fare?.fareUsdc || "0";
        setFareInfo(chargeData.fare);
        addLog(`💰 최종 요금 계산: ${finalFareUsdc} USDC`, "success");
      } else {
        // 이미 charge된 경우 fareInfo 유지
        finalFareUsdc = String(totalCharged.toFixed(6));
        addLog(`💰 누적 요금: ${finalFareUsdc} USDC`, "success");
      }
    } catch (e) {
      addLog(`⚠️ 최종 요금 계산 실패: ${e.message}`, "error");
    }

    // 2) 백엔드 세션 종료 (/end → 에스크로 정산 트리거)
    try {
      await apiCall(`/api/v1/sessions/${sd.sessionId}/end`, "POST", {
        channelId:    sd.channelId,
        userAddress:  mmAddress,
        userFinalSig: "0xmock_signature_for_demo",
      });
      addLog(`🏁 백엔드 세션 종료 & 에스크로 정산 트리거`, "success");
      addLog(`🔄 60초 후 온체인 정산 실행 예정 (잔액 환불 포함)`, "info");
    } catch (e) {
      addLog(`⚠️ 세션 종료 API 오류: ${e.message}`, "error");
    }

    // 3) DB 기록 (payment)
    const settlementAmount = parseFloat(finalFareUsdc) || totalCharged;
    try {
      await base44.entities.Transaction.create({
        type: 'payment', amount: settlementAmount, status: 'completed',
        to_address: svc.serviceId, from_address: mmAddress,
        merchant_name: `${svc.emoji} ${svc.label}`,
        tx_hash: sd.sessionId, wallet_id: wallet?.id,
      }).catch(() => {});

      // 4) 잔액 갱신 (온체인 기준)
      const newBal = await getUsdcBalance(mmAddress);
      localStorage.setItem("mm_balance", newBal);
      if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: newBal }).catch(() => {});
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    } catch (e) {
      addLog(`⚠️ DB 기록 오류: ${e.message}`, "error");
    }

    clearSession();
    setEnding(false);
    setStep("ended");
    addLog(`✅ 정산 완료!`, "success");
  };

  const reset = () => {
    clearSession();
    startedAtRef.current = null;
    sessionRef.current   = null;
    serviceRef.current   = null;
    chargedMinRef.current = 0;
    setStep("select");
    setSelectedService(null);
    setSessionData(null);
    setElapsed(0);
    setLog([]);
    setError(null);
    setFareInfo(null);
    setTotalCharged(0);
  };

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
      <div className="bg-white border-b px-4 py-4 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={() => navigate(-1)} className="text-gray-500 hover:text-gray-700">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
          </svg>
        </button>
        <div>
          <h1 className="text-lg font-bold text-gray-900">QR 결제</h1>
          <p className="text-xs text-gray-500">Perun 오프체인 마이크로페이먼트</p>
        </div>
      </div>

      <div className="px-4 py-6 space-y-4 max-w-md mx-auto">

        {/* ── 서비스 선택 ── */}
        {step === "select" && (
          <div className="space-y-4">
            <h2 className="text-lg font-bold text-gray-800">서비스를 선택하세요</h2>
            {error && (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
                ⚠️ {error}
              </div>
            )}
            {SERVICE_TYPES.map(svc => (
              <button key={svc.id} onClick={() => startSession(svc)}
                className="w-full bg-white rounded-2xl p-5 shadow-sm border border-gray-100 flex items-center gap-4 hover:border-blue-300 hover:shadow-md transition-all text-left">
                <div className="text-4xl">{svc.emoji}</div>
                <div className="flex-1">
                  <div className="font-bold text-gray-900">{svc.label}</div>
                  <div className="text-sm text-gray-500">예치금 {svc.depositUsdc} USDC</div>
                </div>
                <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
                </svg>
              </button>
            ))}
          </div>
        )}

        {/* ── 스캔 중 ── */}
        {step === "scanning" && (
          <div className="bg-white rounded-2xl p-8 shadow-sm text-center">
            <div className="text-5xl mb-4 animate-pulse">📡</div>
            <h2 className="text-xl font-bold mb-2">처리 중...</h2>
            <p className="text-gray-500 text-sm">MetaMask 승인 후 세션을 시작하는 중입니다</p>
          </div>
        )}

        {/* ── 세션 활성 ── */}
        {step === "active" && selectedService && (
          <>
            {/* 서비스 카드 */}
            <div className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl p-6 text-white">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <span className="text-3xl">{selectedService.emoji}</span>
                  <div>
                    <div className="font-bold text-lg">{selectedService.label}</div>
                    <div className="text-blue-200 text-sm">이용 중</div>
                  </div>
                </div>
                <div className="bg-white/20 rounded-xl px-3 py-1 text-sm font-mono">
                  {fmt(elapsed)}
                </div>
              </div>

              {/* Perun 채널 정보 */}
              <div className="bg-white/10 rounded-xl p-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-blue-200">오프체인 채널</span>
                  <span className="font-mono text-xs">{sessionData?.channelId?.slice(0, 16)}...</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-blue-200">예치금</span>
                  <span>{selectedService.depositUsdc} USDC</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-blue-200">누적 차감 (오프체인)</span>
                  <span className="text-yellow-300 font-bold">- {totalCharged.toFixed(4)} USDC</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-blue-200">예상 환불</span>
                  <span className="text-green-300 font-bold">
                    ≈ {Math.max(0, selectedService.depositUsdc - totalCharged).toFixed(4)} USDC
                  </span>
                </div>
              </div>
            </div>

            {/* 현재 요금 정보 */}
            {fareInfo && (
              <div className="bg-white rounded-2xl p-4 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-700 mb-2">💡 최근 요금 업데이트</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="bg-gray-50 rounded-xl p-3">
                    <div className="text-gray-500">단가</div>
                    <div className="font-bold">{fareInfo.ratePerMin || fareInfo.ratePerKwh || '-'} USDC</div>
                  </div>
                  <div className="bg-blue-50 rounded-xl p-3">
                    <div className="text-blue-500">이번 청구</div>
                    <div className="font-bold text-blue-700">{fareInfo.fareUsdc} USDC</div>
                  </div>
                </div>
              </div>
            )}

            {/* 종료 버튼 */}
            <button onClick={endSession} disabled={ending}
              className="w-full bg-red-500 hover:bg-red-600 disabled:opacity-50 text-white font-bold py-4 rounded-2xl shadow-sm transition-all">
              {ending ? "⏳ 정산 중..." : "🏁 서비스 종료 & 정산"}
            </button>
          </>
        )}

        {/* ── 종료 완료 ── */}
        {step === "ended" && (
          <div className="bg-white rounded-2xl p-8 shadow-sm text-center space-y-4">
            <div className="text-5xl">✅</div>
            <h2 className="text-xl font-bold text-gray-900">정산 완료</h2>
            {fareInfo && (
              <div className="bg-gray-50 rounded-xl p-4 space-y-2 text-sm text-left">
                <div className="flex justify-between">
                  <span className="text-gray-500">서비스</span>
                  <span className="font-semibold">{selectedService?.emoji} {selectedService?.label}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">이용 시간</span>
                  <span className="font-semibold">{fmt(elapsed)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">최종 요금</span>
                  <span className="font-bold text-red-600">{fareInfo.fareUsdc} USDC</span>
                </div>
                <div className="flex justify-between border-t pt-2">
                  <span className="text-gray-500">환불 예정</span>
                  <span className="font-bold text-green-600">
                    {Math.max(0, (selectedService?.depositUsdc || 0) - parseFloat(fareInfo.fareUsdc || 0)).toFixed(4)} USDC
                  </span>
                </div>
              </div>
            )}
            <p className="text-xs text-gray-400">온체인 환불은 약 60초 후 MetaMask에서 확인 가능합니다</p>
            <button onClick={reset}
              className="w-full bg-blue-600 text-white font-bold py-3 rounded-xl">
              다시 이용하기
            </button>
          </div>
        )}

        {/* ── 이벤트 로그 ── */}
        {log.length > 0 && (
          <div className="bg-white rounded-2xl p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-700 mb-3">📋 이벤트 로그</h3>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {log.slice().reverse().map((l, i) => (
                <div key={i} className={`text-xs flex gap-2 ${
                  l.type === 'error' ? 'text-red-500' :
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
