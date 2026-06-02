import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  approveUsdcForEscrow,
  userDeposit as escrowUserDeposit,
  getUsdcBalance,
} from '@/lib/walletUtils';

const BACKEND          = "https://payment-backend-production.up.railway.app";
const OPERATOR_ADDRESS = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";

// QR 페이로드 포맷: basecity://pay?svc=ev_charging&id=EV-001&dep=5.0
// 또는 단순 JSON: {"svc":"ev_charging","id":"EV-001","dep":"5.0"}
const SERVICE_META = {
  bicycle:     { label: "공유 자전거", emoji: "🚲", depositUsdc: 3.0 },
  ev_charging: { label: "EV 충전",     emoji: "⚡", depositUsdc: 5.0 },
  parking:     { label: "주차",         emoji: "🅿️", depositUsdc: 2.0 },
};

// 수동 선택용 fallback 목록
const SERVICE_TYPES = [
  { id: "bicycle",     label: "공유 자전거", emoji: "🚲", depositUsdc: 3.0, deviceId: "BIKE-001" },
  { id: "ev_charging", label: "EV 충전",     emoji: "⚡", depositUsdc: 5.0, deviceId: "EV-001"  },
  { id: "parking",     label: "주차",         emoji: "🅿️", depositUsdc: 2.0, deviceId: "PARK-001" },
];

const SESSION_KEY  = "active_session";
const saveSession  = (d) => localStorage.setItem(SESSION_KEY, JSON.stringify(d));
const clearSession = ()  => localStorage.removeItem(SESSION_KEY);
const loadSession  = ()  => { try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; } };

async function apiCall(path, method = "GET", body = null) {
  const res = await fetch(BACKEND + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(data.errors?.[0] || data.error || "API Error");
  return data.data ?? data;
}

/** QR 문자열 파싱 → { serviceType, deviceId, depositUsdc } */
function parseQrPayload(raw) {
  try {
    // URL 스킴: basecity://pay?svc=ev_charging&id=EV-001&dep=5.0
    if (raw.startsWith("basecity://")) {
      const url    = new URL(raw.replace("basecity://", "https://basecity.app/"));
      const svc    = url.searchParams.get("svc");
      const id     = url.searchParams.get("id");
      const dep    = parseFloat(url.searchParams.get("dep") || "0");
      if (svc && SERVICE_META[svc]) return { serviceType: svc, deviceId: id || svc, depositUsdc: dep || SERVICE_META[svc].depositUsdc };
    }
    // JSON 포맷
    const obj = JSON.parse(raw);
    const svc = obj.svc || obj.serviceType;
    if (svc && SERVICE_META[svc]) return { serviceType: svc, deviceId: obj.id || obj.deviceId || svc, depositUsdc: parseFloat(obj.dep || obj.depositUsdc || SERVICE_META[svc].depositUsdc) };
  } catch {}
  return null;
}

export default function ScanPay() {
  const navigate    = useNavigate();
  const queryClient = useQueryClient();
  const mmAddress   = localStorage.getItem("mm_address");

  // ── 상태 ──
  // step: "home" | "camera" | "manual" | "processing" | "active" | "ending" | "ended"
  const [step,         setStep]         = useState("home");
  const [selectedSvc,  setSelectedSvc]  = useState(null);  // { serviceType, deviceId, depositUsdc }
  const [sessionData,  setSessionData]  = useState(null);
  const [elapsed,      setElapsed]      = useState(0);
  const [totalCharged, setTotalCharged] = useState(0);
  const [fareInfo,     setFareInfo]     = useState(null);
  const [ending,       setEnding]       = useState(false);
  const [log,          setLog]          = useState([]);
  const [holdCountdown,setHoldCountdown]= useState(null);
  const [cameraError,  setCameraError]  = useState(null);

  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const streamRef   = useRef(null);
  const scannerRef  = useRef(null);
  const timerRef    = useRef(null);
  const holdTimerRef= useRef(null);

  // 로컬 세션 복구
  useEffect(() => {
    const saved = loadSession();
    if (saved?.sessionId && saved?.status === "active") {
      setSessionData(saved);
      setSelectedSvc(saved.svc);
      setStep("active");
    }
  }, []);

  // 경과 시간 타이머
  useEffect(() => {
    if (step === "active") {
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      clearInterval(timerRef.current);
      if (step === "home") setElapsed(0);
    }
    return () => clearInterval(timerRef.current);
  }, [step]);

  // holdDeadline 카운트다운
  useEffect(() => {
    if (sessionData?.holdDeadline) {
      const tick = () => {
        const left = sessionData.holdDeadline - Math.floor(Date.now() / 1000);
        setHoldCountdown(left > 0 ? left : 0);
      };
      tick();
      holdTimerRef.current = setInterval(tick, 1000);
    }
    return () => clearInterval(holdTimerRef.current);
  }, [sessionData?.holdDeadline]);

  const addLog = (msg, type = "info") =>
    setLog(prev => [...prev, { msg, type, ts: Date.now() }]);

  // ── 카메라 시작 ──────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 640 }, height: { ideal: 480 } }
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      startQrScan();
    } catch (err) {
      setCameraError(`카메라 접근 실패: ${err.message}`);
    }
  }, []);

  const stopCamera = useCallback(() => {
    if (scannerRef.current) { clearInterval(scannerRef.current); scannerRef.current = null; }
    if (streamRef.current)  { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
  }, []);

  // QR 스캔 루프 (BarcodeDetector API 우선, fallback 없음)
  const startQrScan = useCallback(() => {
    if (!("BarcodeDetector" in window)) {
      setCameraError("이 브라우저는 QR 스캔을 지원하지 않습니다. 수동 선택을 이용해주세요.");
      return;
    }
    const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
    scannerRef.current = setInterval(async () => {
      if (!videoRef.current || videoRef.current.readyState < 2) return;
      try {
        const codes = await detector.detect(videoRef.current);
        if (codes.length > 0) {
          const raw    = codes[0].rawValue;
          const parsed = parseQrPayload(raw);
          if (parsed) {
            stopCamera();
            onQrScanned(parsed);
          }
        }
      } catch {}
    }, 300);
  }, [stopCamera]);

  useEffect(() => {
    if (step === "camera") startCamera();
    else stopCamera();
  }, [step, startCamera, stopCamera]);

  // ── QR 스캔 성공 → 결제 시작 ─────────────────────────────────────────────────
  const onQrScanned = useCallback(async (svc) => {
    setSelectedSvc(svc);
    await startPayment(svc);
  }, [mmAddress]);

  // ── 수동 선택 → 결제 시작 ─────────────────────────────────────────────────────
  const onManualSelect = async (svcItem) => {
    const svc = { serviceType: svcItem.id, deviceId: svcItem.deviceId, depositUsdc: svcItem.depositUsdc };
    setSelectedSvc(svc);
    await startPayment(svc);
  };

  // ── 결제 시작 핵심 로직 ──────────────────────────────────────────────────────
  const startPayment = async (svc) => {
    if (!mmAddress) { alert("먼저 MetaMask를 연결하세요"); return; }
    setStep("processing");
    setLog([]);
    try {
      // 1. 백엔드 세션 생성
      addLog("① 세션 생성 중...", "info");
      const startData = await apiCall("/api/v1/sessions/start", "POST", {
        userAddress:  mmAddress,
        serviceType:  svc.serviceType,
        depositUsdc:  String(svc.depositUsdc),
      });
      const { sessionId, channelId, escrowId, holdDeadline } = startData;
      if (!escrowId || !holdDeadline) throw new Error("백엔드 응답에 escrowId/holdDeadline 없음");
      addLog(`✅ 세션: ${sessionId.slice(0, 8)}...`, "success");

      // 2. USDC Approve
      addLog("② MetaMask: USDC 승인 서명 요청...", "info");
      await approveUsdcForEscrow(mmAddress, svc.depositUsdc);
      addLog("✅ USDC 승인 완료", "success");

      // 3. userDeposit
      addLog("③ MetaMask: 에스크로 예치 서명 요청...", "info");
      const depositTxHash = await escrowUserDeposit(mmAddress, escrowId, OPERATOR_ADDRESS, svc.depositUsdc, holdDeadline);
      addLog(`✅ TX: ${depositTxHash.slice(0, 16)}...`, "success");

      // 4. 백엔드 예치 기록
      addLog("④ 예치 기록 중...", "info");
      await apiCall(`/api/v1/sessions/${sessionId}/deposit`, "POST", {
        channelId, userAddress: mmAddress,
        operatorAddress: OPERATOR_ADDRESS,
        depositUsdc: String(svc.depositUsdc),
        holdDeadline, depositTxHash,
      });
      addLog("✅ 예치 완료! 서비스 시작", "success");

      const sd = { sessionId, channelId, escrowId, holdDeadline, svc, status: "active", depositTxHash };
      saveSession(sd);
      setSessionData(sd);
      setStep("active");

    } catch (err) {
      addLog(`❌ ${err.message}`, "error");
      setStep("home");
    }
  };

  // ── Charge (1분마다 자동 청구) ────────────────────────────────────────────────
  const doCharge = useCallback(async () => {
    if (!sessionData) return;
    try {
      const res = await apiCall(`/api/v1/sessions/${sessionData.sessionId}/charge`, "POST", {
        channelId:   sessionData.channelId,
        userAddress: mmAddress,
        serviceType: sessionData.svc.serviceType,
        usage: { durationMinutes: 1 },
      });
      const fare = parseFloat(res.fare?.fareUsdc || "0");
      setTotalCharged(c => c + fare);
      setFareInfo(res.fare);
    } catch {}
  }, [sessionData, mmAddress]);

  useEffect(() => {
    if (step !== "active") return;
    const id = setInterval(doCharge, 60_000);
    return () => clearInterval(id);
  }, [step, doCharge]);

  // ── 세션 종료 ─────────────────────────────────────────────────────────────────
  const endSession = async () => {
    if (!sessionData || ending) return;
    setEnding(true);
    setStep("ending");
    setLog([]);
    try {
      addLog("① 세션 종료 요청...", "info");
      const res = await apiCall(`/api/v1/sessions/${sessionData.sessionId}/end`, "POST", {
        channelId:    sessionData.channelId,
        userAddress:  mmAddress,
        userFinalSig: String(totalCharged.toFixed(6)),
      });
      addLog(`✅ 요금: ${res.fareUsdc} USDC`, "success");
      addLog(`✅ 환불: ${res.refundUsdc} USDC (holdDeadline 후 지갑으로)`, "success");

      clearSession();
      setSessionData({ ...sessionData, result: res, status: "ended" });
      setStep("ended");
      queryClient.invalidateQueries({ queryKey: ['sessions-history'] });
    } catch (err) {
      addLog(`❌ ${err.message}`, "error");
      setStep("active");
    } finally {
      setEnding(false);
    }
  };

  const formatTime = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

  // ══════════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════════
  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="max-w-md mx-auto px-4 pt-6 space-y-4">

        {/* Header */}
        <div className="flex items-center gap-3">
          <button onClick={() => { stopCamera(); setStep("home"); navigate("/"); }}
            className="p-2 rounded-xl hover:bg-gray-100 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
          <h1 className="text-lg font-bold text-gray-900">QR 결제</h1>
        </div>

        {/* ── HOME: QR 스캔 / 수동 선택 ── */}
        {step === "home" && (
          <div className="space-y-4">
            {/* QR 스캔 버튼 */}
            <button onClick={() => setStep("camera")}
              className="w-full bg-blue-600 text-white rounded-2xl p-6 flex flex-col items-center gap-3 shadow-lg active:scale-95 transition-transform">
              <div className="text-5xl">📷</div>
              <div>
                <div className="text-lg font-bold">QR 코드 스캔</div>
                <div className="text-blue-100 text-sm">기기의 QR 코드를 카메라로 인식</div>
              </div>
            </button>

            {/* 수동 선택 */}
            <div className="bg-white rounded-2xl p-4 shadow-sm">
              <p className="text-xs text-gray-400 mb-3 font-medium">또는 서비스 직접 선택</p>
              <div className="space-y-2">
                {SERVICE_TYPES.map(svc => (
                  <button key={svc.id} onClick={() => { setStep("manual"); }}
                    className="w-full flex items-center gap-4 p-4 rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-all text-left">
                    <span className="text-3xl">{svc.emoji}</span>
                    <div className="flex-1">
                      <div className="font-semibold text-gray-900">{svc.label}</div>
                      <div className="text-xs text-gray-400">{svc.deviceId} · 보증금 {svc.depositUsdc} USDC</div>
                    </div>
                    <svg className="w-4 h-4 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/>
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── CAMERA: QR 스캔 화면 ── */}
        {step === "camera" && (
          <div className="space-y-3">
            <div className="relative rounded-2xl overflow-hidden bg-black shadow-lg" style={{ aspectRatio: "4/3" }}>
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted autoPlay />
              <canvas ref={canvasRef} className="hidden" />
              {/* 스캔 가이드 오버레이 */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-52 h-52 border-2 border-white rounded-2xl opacity-70 relative">
                  <div className="absolute top-0 left-0 w-6 h-6 border-t-4 border-l-4 border-blue-400 rounded-tl-lg" />
                  <div className="absolute top-0 right-0 w-6 h-6 border-t-4 border-r-4 border-blue-400 rounded-tr-lg" />
                  <div className="absolute bottom-0 left-0 w-6 h-6 border-b-4 border-l-4 border-blue-400 rounded-bl-lg" />
                  <div className="absolute bottom-0 right-0 w-6 h-6 border-b-4 border-r-4 border-blue-400 rounded-br-lg" />
                  {/* 스캔 라인 애니메이션 */}
                  <div className="absolute top-0 left-0 right-0 h-0.5 bg-blue-400 animate-[scan_2s_linear_infinite]" style={{ boxShadow: '0 0 8px #60a5fa' }} />
                </div>
              </div>
            </div>

            {cameraError ? (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">{cameraError}</div>
            ) : (
              <p className="text-center text-sm text-gray-500">기기의 QR 코드를 사각형 안에 맞춰주세요</p>
            )}

            <div className="flex gap-2">
              <button onClick={() => { stopCamera(); setStep("home"); }}
                className="flex-1 py-3 rounded-xl border border-gray-200 text-gray-600 font-medium text-sm">
                취소
              </button>
              <button onClick={() => { stopCamera(); setStep("manual"); }}
                className="flex-1 py-3 rounded-xl bg-gray-100 text-gray-700 font-medium text-sm">
                직접 선택
              </button>
            </div>
          </div>
        )}

        {/* ── MANUAL: 서비스 선택 ── */}
        {step === "manual" && (
          <div className="bg-white rounded-2xl p-4 shadow-sm space-y-2">
            <h2 className="font-bold text-gray-800 mb-3">서비스 선택</h2>
            {SERVICE_TYPES.map(svc => (
              <button key={svc.id} onClick={() => onManualSelect(svc)}
                className="w-full flex items-center gap-4 p-4 rounded-xl border border-gray-100 hover:border-blue-300 hover:bg-blue-50 transition-all text-left active:scale-[0.98]">
                <span className="text-3xl">{svc.emoji}</span>
                <div className="flex-1">
                  <div className="font-semibold text-gray-900">{svc.label}</div>
                  <div className="text-xs text-gray-400">{svc.deviceId}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-blue-600">{svc.depositUsdc} USDC</div>
                  <div className="text-xs text-gray-400">보증금</div>
                </div>
              </button>
            ))}
            <button onClick={() => setStep("home")}
              className="w-full py-3 rounded-xl text-gray-400 text-sm">← 돌아가기</button>
          </div>
        )}

        {/* ── PROCESSING: MetaMask 서명 진행 중 ── */}
        {step === "processing" && (
          <div className="bg-white rounded-2xl p-8 shadow-sm text-center space-y-4">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto">
              <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
            <h2 className="text-lg font-bold text-gray-900">결제 준비 중</h2>
            <div className="text-sm text-gray-500 bg-gray-50 rounded-xl p-4 text-left space-y-2">
              {log.map((l, i) => (
                <div key={i} className={`flex gap-2 ${l.type === "error" ? "text-red-600" : l.type === "success" ? "text-green-600" : "text-gray-600"}`}>
                  <span>{l.msg}</span>
                </div>
              ))}
              {log.length === 0 && <div className="text-gray-400">진행 중...</div>}
            </div>
          </div>
        )}

        {/* ── ACTIVE: 세션 활성 ── */}
        {step === "active" && selectedSvc && (
          <div className="space-y-3">
            {/* 서비스 카드 */}
            <div className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl p-6 text-white shadow-lg">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-4xl">{SERVICE_META[selectedSvc.serviceType]?.emoji || '📦'}</span>
                <div>
                  <div className="font-bold text-lg">{SERVICE_META[selectedSvc.serviceType]?.label}</div>
                  <div className="text-blue-200 text-sm">{selectedSvc.deviceId}</div>
                </div>
                <div className="ml-auto flex items-center gap-1">
                  <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                  <span className="text-xs text-green-300">이용 중</span>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="bg-white/10 rounded-xl p-3">
                  <div className="text-xl font-bold font-mono">{formatTime(elapsed)}</div>
                  <div className="text-xs text-blue-200 mt-0.5">경과 시간</div>
                </div>
                <div className="bg-white/10 rounded-xl p-3">
                  <div className="text-xl font-bold">{totalCharged.toFixed(4)}</div>
                  <div className="text-xs text-blue-200 mt-0.5">USDC 청구</div>
                </div>
                <div className="bg-white/10 rounded-xl p-3">
                  <div className="text-xl font-bold">{holdCountdown !== null ? (holdCountdown > 0 ? `${holdCountdown}s` : "✅") : "--"}</div>
                  <div className="text-xs text-blue-200 mt-0.5">정산 대기</div>
                </div>
              </div>
            </div>

            {/* 세션 정보 */}
            <div className="bg-white rounded-2xl p-4 shadow-sm text-sm space-y-2">
              <div className="flex justify-between text-gray-500">
                <span>세션 ID</span>
                <span className="font-mono text-gray-800">{sessionData?.sessionId?.slice(0,12)}...</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>보증금</span>
                <span className="font-bold text-gray-800">{selectedSvc.depositUsdc} USDC</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>예상 환불</span>
                <span className="font-bold text-green-600">
                  {(selectedSvc.depositUsdc - totalCharged).toFixed(4)} USDC
                </span>
              </div>
            </div>

            {/* 종료 버튼 */}
            <button onClick={endSession}
              className="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-4 rounded-2xl shadow-lg active:scale-95 transition-all">
              서비스 종료 및 정산
            </button>
          </div>
        )}

        {/* ── ENDING: 종료 처리 중 ── */}
        {step === "ending" && (
          <div className="bg-white rounded-2xl p-8 shadow-sm text-center space-y-4">
            <div className="text-5xl animate-pulse">⚡</div>
            <h2 className="text-lg font-bold">정산 처리 중...</h2>
            <div className="text-sm text-gray-500 bg-gray-50 rounded-xl p-4 text-left space-y-2">
              {log.map((l, i) => (
                <div key={i} className={`${l.type === "error" ? "text-red-600" : l.type === "success" ? "text-green-600" : "text-gray-600"}`}>
                  {l.msg}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── ENDED: 완료 ── */}
        {step === "ended" && sessionData?.result && (
          <div className="space-y-3">
            <div className="bg-white rounded-2xl p-6 shadow-sm text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
                </svg>
              </div>
              <h2 className="text-xl font-bold text-gray-900 mb-1">결제 완료</h2>
              <p className="text-sm text-gray-500">holdDeadline 이후 환불이 지갑으로 자동 전송됩니다</p>
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex justify-between py-2 border-b border-gray-50">
                <span className="text-gray-500 text-sm">이용 요금</span>
                <span className="font-bold text-gray-900">{sessionData.result.fareUsdc} USDC</span>
              </div>
              <div className="flex justify-between py-2 border-b border-gray-50">
                <span className="text-gray-500 text-sm">환불 예정</span>
                <span className="font-bold text-green-600">{sessionData.result.refundUsdc} USDC</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-gray-500 text-sm">이용 시간</span>
                <span className="font-mono text-gray-900">{formatTime(elapsed)}</span>
              </div>
            </div>

            {sessionData.result.txHash && sessionData.result.txHash !== 'settled_via_perun' && (
              <a href={`https://sepolia.basescan.org/tx/${sessionData.result.txHash}`} target="_blank" rel="noreferrer"
                className="block w-full text-center bg-gray-100 hover:bg-gray-200 text-gray-600 py-3 rounded-xl text-sm transition-colors">
                🔗 BaseScan에서 TX 확인
              </a>
            )}

            <button onClick={() => { setStep("home"); setSelectedSvc(null); setSessionData(null); setTotalCharged(0); setElapsed(0); setLog([]); }}
              className="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-lg">
              홈으로
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
