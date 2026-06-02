import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  approveUsdcForEscrow,
  userDeposit as escrowUserDeposit,
} from '@/lib/walletUtils';
import BottomNav from '@/components/wallet/BottomNav';

const BACKEND          = "https://payment-backend-production.up.railway.app";
const OPERATOR_ADDRESS = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";

const SERVICE_META = {
  bicycle:     { label: "공유 자전거", emoji: "🚲", depositUsdc: 3.0 },
  ev_charging: { label: "EV 충전",     emoji: "⚡", depositUsdc: 5.0 },
  parking:     { label: "주차",         emoji: "🅿️", depositUsdc: 2.0 },
};

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
    if (raw.startsWith("basecity://")) {
      const url    = new URL(raw.replace("basecity://", "https://basecity.app/"));
      const svc    = url.searchParams.get("svc");
      const id     = url.searchParams.get("id");
      const dep    = parseFloat(url.searchParams.get("dep") || "0");
      if (svc && SERVICE_META[svc])
        return { serviceType: svc, deviceId: id || svc, depositUsdc: dep || SERVICE_META[svc].depositUsdc };
    }
    const obj = JSON.parse(raw);
    const svc = obj.svc || obj.serviceType;
    if (svc && SERVICE_META[svc])
      return { serviceType: svc, deviceId: obj.id || obj.deviceId || svc, depositUsdc: parseFloat(obj.dep || obj.depositUsdc || SERVICE_META[svc].depositUsdc) };
  } catch {}
  return null;
}

export default function ScanPay() {
  const navigate    = useNavigate();
  const queryClient = useQueryClient();
  const [mmAddress, setMmAddress] = React.useState(() => localStorage.getItem("mm_address"));

  // localStorage 변경 감지 (다른 탭/컴포넌트에서 연결된 경우)
  React.useEffect(() => {
    const sync = () => setMmAddress(localStorage.getItem("mm_address"));
    window.addEventListener('storage', sync);
    // 포커스 복귀 시 재동기화 (MetaMask 앱 승인 후 돌아올 때)
    window.addEventListener('focus', sync);
    return () => { window.removeEventListener('storage', sync); window.removeEventListener('focus', sync); };
  }, []);

  // step: "home" | "camera" | "manual" | "processing" | "active" | "ending" | "ended"
  const [step,          setStep]          = useState("home");
  const [selectedSvc,   setSelectedSvc]   = useState(null);
  const [sessionData,   setSessionData]   = useState(null);
  const [elapsed,       setElapsed]       = useState(0);
  const [totalCharged,  setTotalCharged]  = useState(0);
  const [fareInfo,      setFareInfo]      = useState(null);
  const [ending,        setEnding]        = useState(false);
  const [log,           setLog]           = useState([]);
  const [holdCountdown, setHoldCountdown] = useState(null);
  const [cameraError,   setCameraError]   = useState(null);
  const [scanReady,     setScanReady]     = useState(false);

  const videoRef     = useRef(null);
  const canvasRef    = useRef(null);
  const streamRef    = useRef(null);
  const rafRef       = useRef(null);
  const timerRef     = useRef(null);
  const holdTimerRef = useRef(null);
  const jsQrRef      = useRef(null);  // jsQR 라이브러리 동적 로드

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

  // ── jsQR 동적 로드 ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (step !== "camera") return;
    import('jsqr').then(mod => {
      jsQrRef.current = mod.default;
      setScanReady(true);
    }).catch(() => {
      setScanReady(true); // BarcodeDetector fallback으로 계속
    });
  }, [step]);

  // ── 카메라 시작 ──────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    setCameraError(null);
    setScanReady(false);
    try {
      const constraints = {
        video: {
          facingMode: { ideal: "environment" },
          width:  { ideal: 1280 },
          height: { ideal: 720 },
        }
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
    } catch (err) {
      setCameraError(`카메라 접근 실패: ${err.message}`);
    }
  }, []);

  const stopCamera = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setScanReady(false);
  }, []);

  // ── QR 스캔 루프 (jsQR + BarcodeDetector 이중 지원) ──────────────────────────
  const runScanLoop = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(runScanLoop);
      return;
    }

    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    let found = false;

    // 방법 1: jsQR
    if (jsQrRef.current) {
      try {
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQrRef.current(imageData.data, canvas.width, canvas.height);
        if (code?.data) {
          const parsed = parseQrPayload(code.data);
          if (parsed) { found = true; stopCamera(); onQrSuccess(parsed); return; }
        }
      } catch {}
    }

    // 방법 2: BarcodeDetector (Chrome Android 등)
    if (!found && "BarcodeDetector" in window) {
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      detector.detect(video).then(codes => {
        if (codes.length > 0) {
          const parsed = parseQrPayload(codes[0].rawValue);
          if (parsed) { stopCamera(); onQrSuccess(parsed); return; }
        }
      }).catch(() => {});
    }

    if (!found) rafRef.current = requestAnimationFrame(runScanLoop);
  }, [stopCamera]);

  // scanReady 되면 스캔 루프 시작
  useEffect(() => {
    if (scanReady && step === "camera") {
      rafRef.current = requestAnimationFrame(runScanLoop);
    }
    return () => cancelAnimationFrame(rafRef.current);
  }, [scanReady, step, runScanLoop]);

  useEffect(() => {
    if (step === "camera") startCamera();
    else stopCamera();
  }, [step]);

  // ── QR 스캔 성공 ─────────────────────────────────────────────────────────────
  const onQrSuccess = (svc) => {
    setSelectedSvc(svc);
    const addr = localStorage.getItem("mm_address");
    if (!addr) {
      setMmAddress(null);
      setStep("home");
      return;
    }
    startPayment(svc, addr);
  };

  // ── 수동 선택 ─────────────────────────────────────────────────────────────────
  const onManualSelect = (svcItem) => {
    const svc = { serviceType: svcItem.id, deviceId: svcItem.deviceId, depositUsdc: svcItem.depositUsdc };
    setSelectedSvc(svc);
    const addr = localStorage.getItem("mm_address");
    if (!addr) { setStep("home"); return; }
    startPayment(svc, addr);
  };

  // ── 결제 시작 ─────────────────────────────────────────────────────────────────
  const startPayment = async (svc, addr = mmAddress) => {
    if (addr) setMmAddress(addr);
    setStep("processing");
    setLog([]);
    try {
      addLog("① 세션 생성 중...", "info");
      const startData = await apiCall("/api/v1/sessions/start", "POST", {
        userAddress:  addr,
        serviceType:  svc.serviceType,
        depositUsdc:  String(svc.depositUsdc),
      });
      const { sessionId, channelId, escrowId, holdDeadline } = startData;
      if (!escrowId || !holdDeadline) throw new Error("백엔드 응답에 escrowId/holdDeadline 없음");
      addLog(`✅ 세션: ${sessionId.slice(0, 8)}...`, "success");

      addLog("② MetaMask: USDC 승인 서명 요청...", "info");
      await approveUsdcForEscrow(addr, svc.depositUsdc);
      addLog("✅ USDC 승인 완료", "success");

      addLog("③ MetaMask: 에스크로 예치 서명 요청...", "info");
      const depositTxHash = await escrowUserDeposit(addr, escrowId, OPERATOR_ADDRESS, svc.depositUsdc, holdDeadline);
      addLog(`✅ TX: ${depositTxHash.slice(0, 16)}...`, "success");

      addLog("④ 예치 기록 중...", "info");
      await apiCall(`/api/v1/sessions/${sessionId}/deposit`, "POST", {
        channelId, userAddress: addr,
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

  // ── Charge 자동 청구 ──────────────────────────────────────────────────────────
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
      addLog(`✅ 환불: ${res.refundUsdc} USDC`, "success");

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
  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="max-w-md mx-auto px-4 pt-6 space-y-4">

        {/* Header */}
        <div className="flex items-center gap-3">
          <button onClick={() => { stopCamera(); navigate("/"); }}
            className="p-2 rounded-xl hover:bg-gray-100 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7"/>
            </svg>
          </button>
          <h1 className="text-lg font-bold text-gray-900">QR 결제</h1>
          {!mmAddress && (
            <span className="ml-auto text-xs bg-red-100 text-red-600 px-2 py-1 rounded-full font-medium">
              MetaMask 미연결
            </span>
          )}
        </div>

        {/* MetaMask 미연결 경고 (항상 상단에) */}
        {!mmAddress && step === "home" && (
          <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 text-sm text-orange-800">
            ⚠️ 홈으로 돌아가서 MetaMask를 먼저 연결해주세요.
            <button onClick={() => navigate("/")}
              className="block mt-2 w-full text-center bg-orange-500 text-white py-2 rounded-xl font-semibold">
              홈으로 이동
            </button>
          </div>
        )}

        {/* ── HOME ── */}
        {step === "home" && mmAddress && (
          <div className="space-y-4">
            <button onClick={() => setStep("camera")}
              className="w-full bg-blue-600 text-white rounded-2xl p-6 flex flex-col items-center gap-3 shadow-lg active:scale-95 transition-transform">
              <div className="text-5xl">📷</div>
              <div>
                <div className="text-lg font-bold">QR 코드 스캔</div>
                <div className="text-blue-100 text-sm">기기의 QR 코드를 카메라로 인식</div>
              </div>
            </button>

            <div className="bg-white rounded-2xl p-4 shadow-sm">
              <p className="text-xs text-gray-400 mb-3 font-medium">또는 서비스 직접 선택</p>
              <div className="space-y-2">
                {SERVICE_TYPES.map(svc => (
                  <button key={svc.id} onClick={() => onManualSelect(svc)}
                    className="w-full flex items-center gap-4 p-4 rounded-xl border border-gray-100 hover:border-blue-200 hover:bg-blue-50 transition-all text-left active:scale-[0.98]">
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

        {/* ── CAMERA ── */}
        {step === "camera" && (
          <div className="space-y-3">
            <div className="relative rounded-2xl overflow-hidden bg-black shadow-lg" style={{ aspectRatio: "4/3" }}>
              <video ref={videoRef} className="w-full h-full object-cover" playsInline muted autoPlay />
              <canvas ref={canvasRef} className="hidden" />

              {/* 스캔 가이드 오버레이 */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-56 h-56 relative">
                  {/* 반투명 마스크 */}
                  <div className="absolute inset-0 border-2 border-white/30 rounded-2xl" />
                  {/* 코너 마커 */}
                  <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-blue-400 rounded-tl-xl" />
                  <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-blue-400 rounded-tr-xl" />
                  <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-blue-400 rounded-bl-xl" />
                  <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-blue-400 rounded-br-xl" />
                  {/* 스캔 라인 */}
                  <div className="absolute left-2 right-2 h-0.5 bg-blue-400 rounded animate-bounce"
                    style={{ top: '50%', boxShadow: '0 0 8px #60a5fa, 0 0 20px #60a5fa' }} />
                </div>
              </div>

              {/* 스캔 중 표시 */}
              {!scanReady && !cameraError && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <div className="text-white text-sm flex items-center gap-2">
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    카메라 준비 중...
                  </div>
                </div>
              )}
            </div>

            {cameraError ? (
              <div className="bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
                {cameraError}
                <p className="mt-1 text-xs text-red-500">브라우저 주소창 좌측 🔒 → 카메라 권한 허용 후 새로고침</p>
              </div>
            ) : (
              <p className="text-center text-sm text-gray-500 flex items-center justify-center gap-1">
                <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse inline-block" />
                기기의 QR 코드를 사각형 안에 맞춰주세요
              </p>
            )}

            <div className="flex gap-2">
              <button onClick={() => { stopCamera(); setStep("home"); }}
                className="flex-1 py-3 rounded-xl border border-gray-200 text-gray-600 font-medium text-sm">
                취소
              </button>
              <button onClick={() => { stopCamera(); setStep("home"); }}
                className="flex-1 py-3 rounded-xl bg-blue-50 text-blue-600 font-medium text-sm">
                직접 선택
              </button>
            </div>
          </div>
        )}

        {/* ── PROCESSING ── */}
        {step === "processing" && (
          <div className="bg-white rounded-2xl p-8 shadow-sm text-center space-y-4">
            <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto">
              <div className="w-8 h-8 border-[3px] border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
            <h2 className="text-lg font-bold text-gray-900">결제 처리 중</h2>
            <div className="text-sm bg-gray-50 rounded-xl p-4 text-left space-y-2">
              {log.length === 0 && <div className="text-gray-400">시작 중...</div>}
              {log.map((l, i) => (
                <div key={i} className={`flex gap-2 ${l.type === "error" ? "text-red-600" : l.type === "success" ? "text-green-600" : "text-gray-600"}`}>
                  {l.msg}
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400">MetaMask 팝업이 뜨면 승인해주세요</p>
          </div>
        )}

        {/* ── ACTIVE ── */}
        {step === "active" && selectedSvc && (
          <div className="space-y-3">
            <div className="bg-gradient-to-br from-blue-600 to-indigo-700 rounded-2xl p-6 text-white shadow-lg">
              <div className="flex items-center gap-3 mb-4">
                <span className="text-4xl">{SERVICE_META[selectedSvc.serviceType]?.emoji || '📦'}</span>
                <div>
                  <div className="font-bold text-lg">{SERVICE_META[selectedSvc.serviceType]?.label}</div>
                  <div className="text-blue-200 text-sm">{selectedSvc.deviceId}</div>
                </div>
                <div className="ml-auto flex items-center gap-1">
                  <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
                  <span className="text-xs text-green-300 font-medium">이용 중</span>
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
                  <div className="text-xs text-blue-200 mt-0.5">홀드 잔여</div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 shadow-sm text-sm space-y-2">
              <div className="flex justify-between text-gray-500">
                <span>세션 ID</span>
                <span className="font-mono text-gray-800 text-xs">{sessionData?.sessionId?.slice(0,14)}...</span>
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

            <button onClick={endSession}
              className="w-full bg-red-500 hover:bg-red-600 text-white font-bold py-4 rounded-2xl shadow-lg active:scale-95 transition-all">
              서비스 종료 및 정산
            </button>
          </div>
        )}

        {/* ── ENDING ── */}
        {step === "ending" && (
          <div className="bg-white rounded-2xl p-8 shadow-sm text-center space-y-4">
            <div className="text-5xl animate-pulse">⚡</div>
            <h2 className="text-lg font-bold">정산 처리 중...</h2>
            <div className="text-sm bg-gray-50 rounded-xl p-4 text-left space-y-2">
              {log.map((l, i) => (
                <div key={i} className={`${l.type === "error" ? "text-red-600" : l.type === "success" ? "text-green-600" : "text-gray-600"}`}>
                  {l.msg}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── ENDED ── */}
        {step === "ended" && sessionData?.result && (
          <div className="space-y-3">
            <div className="bg-white rounded-2xl p-6 shadow-sm text-center">
              <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
                </svg>
              </div>
              <h2 className="text-xl font-bold text-gray-900 mb-1">결제 완료 ✅</h2>
              <p className="text-xs text-gray-400">환불은 holdDeadline 이후 지갑으로 자동 전송됩니다</p>
            </div>

            <div className="bg-white rounded-2xl p-5 shadow-sm space-y-3 text-sm">
              <div className="flex justify-between py-2 border-b border-gray-50">
                <span className="text-gray-500">이용 요금</span>
                <span className="font-bold text-gray-900">{sessionData.result.fareUsdc} USDC</span>
              </div>
              <div className="flex justify-between py-2 border-b border-gray-50">
                <span className="text-gray-500">환불 예정</span>
                <span className="font-bold text-green-600">{sessionData.result.refundUsdc} USDC</span>
              </div>
              <div className="flex justify-between py-2">
                <span className="text-gray-500">이용 시간</span>
                <span className="font-mono text-gray-900">{formatTime(elapsed)}</span>
              </div>
            </div>

            {sessionData.result.txHash && sessionData.result.txHash !== 'settled_via_perun' && (
              <a href={`https://sepolia.basescan.org/tx/${sessionData.result.txHash}`}
                target="_blank" rel="noreferrer"
                className="block w-full text-center bg-gray-100 text-gray-600 py-3 rounded-xl text-sm hover:bg-gray-200 transition-colors">
                🔗 BaseScan에서 TX 확인
              </a>
            )}

            <button onClick={() => {
              setStep("home"); setSelectedSvc(null); setSessionData(null);
              setTotalCharged(0); setElapsed(0); setLog([]);
            }} className="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-lg">
              홈으로
            </button>
          </div>
        )}
      </div>
      <BottomNav />
    </div>
  );
}

