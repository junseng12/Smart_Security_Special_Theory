import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  approveUsdcForEscrow,
  userDeposit as escrowUserDeposit,
} from '@/lib/walletUtils';
import BottomNav from '@/components/wallet/BottomNav';

const BACKEND          = "https://payment-backend-production.up.railway.app";
const OPERATOR_ADDRESS  = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";
const ESCROW_V3_ADDRESS = "0xa2642876a2Aa9F19D22a6e69379bbcA10556977f"; // V3.2

const SERVICE_META = {
  bicycle:     { label: "공유 자전거", emoji: "🚲", depositUsdc: 3.0 },
  ev_charging: { label: "EV 충전",     emoji: "⚡", depositUsdc: 5.0 },
  parking:     { label: "주차",         emoji: "🅿️", depositUsdc: 2.0 },
};

const RATE_PER_MIN = 0.1; // USDC/분 — 분당 0.1 USDC 고정 (rebuild 1781678476)

const SERVICE_TYPES = [
  { id: "bicycle",     label: "공유 자전거", emoji: "🚲", depositUsdc: 3.0, deviceId: "BIKE-001" },
  { id: "ev_charging", label: "EV 충전",     emoji: "⚡", depositUsdc: 5.0, deviceId: "EV-001"  },
  { id: "parking",     label: "주차",         emoji: "🅿️", depositUsdc: 2.0, deviceId: "PARK-001" },
];

const SESSION_KEY  = "active_session";
const saveSession  = (d) => localStorage.setItem(SESSION_KEY, JSON.stringify(d));
const clearSession = ()  => localStorage.removeItem(SESSION_KEY);
const loadSession  = ()  => {
  try {
    const d = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (!d) return null;
    // holdDeadline + 여유 30초 지났으면 만료된 세션 — 자동 정리
    if (d.holdDeadline && Math.floor(Date.now() / 1000) > d.holdDeadline + 30) {
      clearSession(); return null;
    }
    return d;
  } catch { return null; }
};

// processing 단계별 저장 — MetaMask 서명 후 페이지 리마운트 시 재개를 위해
const PROC_KEY    = "payment_processing";
const saveProc    = (d) => localStorage.setItem(PROC_KEY, JSON.stringify({ ...d, savedAt: Date.now() }));
const clearProc   = ()  => localStorage.removeItem(PROC_KEY);
const loadProc    = ()  => {
  try {
    const d = JSON.parse(localStorage.getItem(PROC_KEY));
    if (!d) return null;
    // holdDeadline이 있으면 그것 기준으로 만료 판단 (holdDeadline + 120초 여유)
    if (d.holdDeadline && Math.floor(Date.now() / 1000) > d.holdDeadline + 120) {
      clearProc(); return null;
    }
    // holdDeadline 없으면 savedAt 기준 10분
    if (!d.holdDeadline && d.savedAt && Date.now() - d.savedAt > 10 * 60 * 1000) {
      clearProc(); return null;
    }
    return d;
  } catch { return null; }
};

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
  const jsQrRef         = useRef(null);  // jsQR 라이브러리 동적 로드
  const scannedRef      = useRef(false); // QR 중복 감지 방지 플래그
  const sessionDataRef  = useRef(null);  // liveCharged 계산용 최신 sessionData
  // lastChargeRef 제거 — doCharge 방식 삭제로 불필요
  const resumePaymentRef = useRef(null);  // 항상 최신 resumePayment 참조
const chargeIntervalRef = useRef(null); // ProposeUsageUpdate 주기 호출용

  // 로컬 세션 복구 (active + processing 단계 모두)
  useEffect(() => {
    // 1) 이미 완전히 active 상태인 세션 복구
    const saved = loadSession();
    if (saved?.sessionId && saved?.status === "active") {
      setSessionData(saved);
      setSelectedSvc(saved.svc);
      // totalCharged 초기화 — 화면 표시는 liveCharged(elapsed 기반 연속계산)가 담당
      setTotalCharged(0);
      setStep("active");
      return;
    }
    // 2) processing 중 나갔다가 돌아온 경우 — 마지막 완료 단계부터 재개
    const proc = loadProc();
    if (proc?.sessionId && proc?.svc) {
      setSelectedSvc(proc.svc);
      setStep("processing");
      setLog([{ msg: "⏳ 이전 결제 재개 중...", type: "info" }]);
      // 비동기로 재개 (렌더 완료 후)
      setTimeout(() => resumePaymentRef.current?.(proc), 300);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // sessionDataRef 항상 최신으로 유지
  useEffect(() => { sessionDataRef.current = sessionData; }, [sessionData]);

  // 경과 시간 타이머 — startedAt 기준 절대 계산
  // ★ 핵심: step과 무관하게 startedAt이 localStorage에 있으면 카운팅 유지
  //   (MetaMask 서명 중 processing, 화면 이동, 재마운트 모두 대응)
  useEffect(() => {
    const getStartedAt = () => {
      try {
        // active_session 또는 payment_processing 어디든 startedAt 참조
        const sess = JSON.parse(localStorage.getItem("active_session"));
        if (sess?.startedAt) return sess.startedAt;
        const proc = JSON.parse(localStorage.getItem("payment_processing"));
        if (proc?.startedAt) return proc.startedAt;
        return null;
      } catch { return null; }
    };

    // home/ended 단계 → 모든 타이머 중지
    if (step === "home") {
      clearInterval(timerRef.current);
      clearInterval(chargeIntervalRef.current);
      setElapsed(0);
      return () => {
        clearInterval(timerRef.current);
        clearInterval(chargeIntervalRef.current);
      };
    }

    // active / processing / ending / camera / manual → startedAt 있으면 절대 시간으로 카운팅
    const tick = () => {
      const startedAt = getStartedAt();
      if (startedAt) {
        setElapsed(Math.floor((Date.now() - startedAt) / 1000));
      }
      // startedAt 없으면 카운팅 안 함 (결제 시작 전)
    };
    tick();
    timerRef.current = setInterval(tick, 1000);

    // ── ProposeUsageUpdate: step=active일 때만 60초마다 오프체인 서명 누적 ──
    if (step === "active") {
      chargeIntervalRef.current = setInterval(async () => {
        const sd = sessionDataRef.current;
        if (!sd?.sessionId || !sd?.channelId) return;
        try {
          await apiCall(`/api/v1/sessions/${sd.sessionId}/charge`, "POST", {
            channelId:   sd.channelId,
            userAddress: localStorage.getItem("mm_address") || "",
            serviceType: sd.svc?.serviceType || "bicycle",
            usage: { durationMinutes: 1 },
          });
          // 성공 시 localStorage charged_usdc 누적 (화면 표시는 liveCharged가 담당)
          try {
            const s = JSON.parse(localStorage.getItem("active_session") || "{}");
            s.chargedNonce = (s.chargedNonce || 0) + 1;
            localStorage.setItem("active_session", JSON.stringify(s));
          } catch {}
        } catch (e) {
          // 오프체인 서명 실패는 치명적이지 않음 — fareEngine 폴백으로 정산 가능
          console.warn("[ProposeUsageUpdate] 오프체인 서명 실패:", e.message);
        }
      }, 60_000); // 60초마다
    }

    return () => {
      clearInterval(timerRef.current);
      clearInterval(chargeIntervalRef.current);
    };
  }, [step]);

  // holdDeadline 카운트다운 + 만료 시 자동 종료
  useEffect(() => {
    if (sessionData?.holdDeadline) {
      const tick = () => {
        const left = sessionData.holdDeadline - Math.floor(Date.now() / 1000);
        setHoldCountdown(left > 0 ? left : 0);
        // holdDeadline 만료 시 자동 endSession 시도 (한 번만)
        if (left <= 0 && step === "active") {
          clearInterval(holdTimerRef.current);
          endSession();
        }
      };
      tick();
      holdTimerRef.current = setInterval(tick, 1000);
    }
    return () => clearInterval(holdTimerRef.current);
  }, [sessionData?.holdDeadline]); // eslint-disable-line react-hooks/exhaustive-deps

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
      // 모바일: 후면 카메라 우선 / 데스크탑: 기본 카메라
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
      } catch {
        // facingMode 실패 시 any 카메라로 fallback (데스크탑 대응)
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
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

  // 카메라 시작 시 scannedRef 초기화
  useEffect(() => {
    if (step === "camera") scannedRef.current = false;
  }, [step]);

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
          if (parsed && !scannedRef.current) {
            scannedRef.current = true;
            found = true;
            stopCamera();
            onQrSuccess(parsed);
            return;
          }
        }
      } catch {}
    }

    // 방법 2: BarcodeDetector (Chrome Android 등) — 비동기라 scannedRef로 중복 방지
    if (!found && "BarcodeDetector" in window) {
      const detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      detector.detect(video).then(codes => {
        if (codes.length > 0 && !scannedRef.current) {
          const parsed = parseQrPayload(codes[0].rawValue);
          if (parsed) {
            scannedRef.current = true;
            stopCamera();
            onQrSuccess(parsed);
          }
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
  const onQrSuccess = async (svc) => {
    setSelectedSvc(svc);
    let addr = localStorage.getItem("mm_address") || mmAddress;
    if (!addr) {
      if (!window.ethereum) { alert("MetaMask 앱 브라우저에서 열어주세요."); return; }
      try {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        addr = accounts[0];
        if (!addr) return;
        localStorage.setItem("mm_address", addr);
        setMmAddress(addr);
      } catch { return; }
    }
    startPayment(svc, addr);
  };

  // ── 수동 선택 ─────────────────────────────────────────────────────────────────
  const onManualSelect = async (svcItem) => {
    const svc = { serviceType: svcItem.id, deviceId: svcItem.deviceId, depositUsdc: svcItem.depositUsdc };
    setSelectedSvc(svc);
    let addr = localStorage.getItem("mm_address") || mmAddress;
    // MetaMask 미연결 시 연결 먼저 시도
    if (!addr) {
      if (!window.ethereum) {
        alert("MetaMask가 필요합니다.\nMetaMask 앱 브라우저에서 열어주세요.");
        return;
      }
      try {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        addr = accounts[0];
        if (!addr) return;
        localStorage.setItem("mm_address", addr);
        setMmAddress(addr);
      } catch (e) {
        alert("MetaMask 연결을 거부하셨습니다.");
        return;
      }
    }
    startPayment(svc, addr);
  };

  // ── 결제 재개 (processing 중 나갔다가 돌아온 경우) ─────────────────────────────
  // resumePaymentRef 항상 최신으로 유지 — useEffect([]) 클로저 버그 방지
  useEffect(() => { resumePaymentRef.current = resumePayment; });

  const resumePayment = async (proc) => {
    const { svc, addr, sessionId, channelId, escrowId, holdDeadline, stage } = proc;
    if (!window.ethereum) {
      addLog("❌ MetaMask를 찾을 수 없습니다. MetaMask 앱 브라우저를 사용해주세요.", "error");
      setTimeout(() => { clearProc(); setStep("home"); }, 5000);
      return;
    }
    try {
      // stage: "session_created" → approve부터 재개
      //         "approved"        → userDeposit부터 재개
      //         "deposited"       → /deposit API 호출부터 재개
      if (stage === "session_created" || !stage) {
        addLog("② MetaMask: USDC 승인 서명 요청...", "info");
        await approveUsdcForEscrow(addr, ESCROW_V3_ADDRESS, svc.depositUsdc);
        addLog("✅ USDC 승인 완료 (체인 반영 확인됨)", "success");
        saveProc({ ...proc, stage: "approved", startedAt: null });
      }

      if (stage !== "deposited") {
        addLog("③ MetaMask: 에스크로 예치 서명 요청...", "info");
        const depositTxHash = await escrowUserDeposit(addr, escrowId, OPERATOR_ADDRESS, svc.depositUsdc, holdDeadline);
        addLog(`✅ TX: ${depositTxHash.slice(0, 16)}...`, "success");
        saveProc({ ...proc, stage: "deposited", depositTxHash, startedAt: null });
        proc.depositTxHash = depositTxHash;
      }

      addLog("④ 예치 기록 중...", "info");
      const resumeStartedAt = Date.now(); // deposit 완료 시점이 실제 서비스 시작
      await apiCall(`/api/v1/sessions/${sessionId}/deposit`, "POST", {
        channelId, userAddress: addr,
        operatorAddress: OPERATOR_ADDRESS,
        depositUsdc: String(svc.depositUsdc),
        holdDeadline, depositTxHash: proc.depositTxHash,
        serviceStartedAt: resumeStartedAt,
      });
      addLog("✅ 예치 완료! 서비스 시작", "success");
      const sd = { sessionId, channelId, escrowId, holdDeadline, svc, status: "active", depositTxHash: proc.depositTxHash,
        startedAt: resumeStartedAt, totalCharged: 0 };
      clearProc();
      saveSession(sd);
      setSessionData(sd);
      setStep("active");
    } catch (err) {
      addLog(`❌ 재개 실패: ${err.message}`, "error");
      addLog("처음부터 다시 시도해주세요.", "info");
      setTimeout(() => { clearProc(); setStep("home"); }, 6000);
    }
  };

  // ── 결제 시작 ─────────────────────────────────────────────────────────────────
  const startPayment = async (svc, addr = mmAddress) => {
    if (addr) setMmAddress(addr);
    setStep("processing");
    setLog([]);
    if (!window.ethereum) {
      addLog("❌ MetaMask를 찾을 수 없습니다.", "error");
      addLog("📱 MetaMask 앱 → 브라우저에서 이 페이지를 열어주세요.", "info");
      setTimeout(() => setStep("home"), 6000);
      return;
    }
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

      // ★ 세션 생성 직후 processing 상태 저장 — 이후 MetaMask 서명 시 페이지 리마운트 대비
      //   startedAt은 deposit 완료(실제 서비스 시작) 후 기록하므로 여기선 null
      saveProc({ svc, addr, sessionId, channelId, escrowId, holdDeadline, stage: "session_created", startedAt: null });

      addLog("② MetaMask: USDC 승인 서명 요청...", "info");
      await approveUsdcForEscrow(addr, ESCROW_V3_ADDRESS, svc.depositUsdc);
      addLog("✅ USDC 승인 완료", "success");
      saveProc({ svc, addr, sessionId, channelId, escrowId, holdDeadline, stage: "approved", startedAt: null });

      addLog("③ MetaMask: 에스크로 예치 서명 요청...", "info");
      const depositTxHash = await escrowUserDeposit(addr, escrowId, OPERATOR_ADDRESS, svc.depositUsdc, holdDeadline);
      addLog(`✅ TX: ${depositTxHash.slice(0, 16)}...`, "success");
      saveProc({ svc, addr, sessionId, channelId, escrowId, holdDeadline, stage: "deposited", depositTxHash, startedAt: null });

      addLog("④ 예치 기록 중...", "info");
      const serviceStartedAt = Date.now(); // ★ 실제 서비스 시작 시점 (MetaMask 서명 시간 제외)
      await apiCall(`/api/v1/sessions/${sessionId}/deposit`, "POST", {
        channelId, userAddress: addr,
        operatorAddress: OPERATOR_ADDRESS,
        depositUsdc: String(svc.depositUsdc),
        holdDeadline, depositTxHash,
        serviceStartedAt, // 백엔드 DB started_at 동기화
      });
      addLog("✅ 예치 완료! 서비스 시작", "success");

      const sd = { sessionId, channelId, escrowId, holdDeadline, svc, status: "active", depositTxHash, startedAt: serviceStartedAt, totalCharged: 0 };
      clearProc();
      saveSession(sd);
      setSessionData(sd);
      setStep("active");

    } catch (err) {
      addLog(`❌ 오류: ${err.message}`, "error");
      setTimeout(() => { clearProc(); setStep("home"); }, 6000);
    }
  };

  // ── Charge 자동 청구 ──────────────────────────────────────────────────────────
  // sessionDataRef 사용 → 의존성 배열 고정 → interval이 재생성되지 않음
  // liveCharged — 분 단위 스텝 계산 (분당 0.1 USDC 고정)
  // 완성된 분(elapsedMinutes)마다 0.1 USDC씩 계단식으로 올라감
  const elapsedMinutes = Math.floor(elapsed / 60); // 완성된 분만 카운트
  const liveCharged = (() => {
    const sd = sessionDataRef.current;
    if (!sd) return totalCharged;
    const depositUsdc = parseFloat(sd.svc?.depositUsdc || 3.0);
    return Math.min(
      Math.round(elapsedMinutes * RATE_PER_MIN * 1_000_000) / 1_000_000,
      depositUsdc
    );
  })();

  // ── 세션 종료 ─────────────────────────────────────────────────────────────────
  const endSession = async () => {
    if (!sessionData || ending) return;
    setEnding(true);
    setStep("ending");
    setLog([]);
    try {
      // 오프체인 누적 nonce 확인 (로그용)
      const activeSession = JSON.parse(localStorage.getItem("active_session") || "{}");
      const nonces = activeSession.chargedNonce || 0;
      addLog(`① 세션 종료 요청... (오프체인 서명 누적: ${nonces}회)`, "info");
      const res = await apiCall(`/api/v1/sessions/${sessionData.sessionId}/end`, "POST", {
        channelId:    sessionData.channelId,
        userAddress:  mmAddress || localStorage.getItem("mm_address"),
        userFinalSig: String(liveCharged.toFixed(6)),
        // fareUsdc는 백엔드가 started_at 기준으로 직접 계산 — 프론트 값 전달 안 함
      });
      // ── 프론트 계산값 우선 적용 ──────────────────────────────────────
      // 백엔드가 0을 반환하더라도 프론트에서 누적한 liveCharged를 기준으로 표시
      const depositAmt = parseFloat(sessionData.svc?.depositUsdc || 3.0);
      const frontFare   = parseFloat(liveCharged.toFixed(6));
      const backFare    = parseFloat(res.fareUsdc || 0);
      // 백엔드값이 0이거나 비정상(음수)이면 프론트 계산값 사용
      const finalFare   = (backFare > 0 && backFare <= depositAmt) ? backFare : frontFare;
      const finalRefund = parseFloat((depositAmt - finalFare).toFixed(6));

      const finalResult = {
        ...res,
        fareUsdc:   finalFare.toFixed(6),
        refundUsdc: finalRefund.toFixed(6),
      };
      addLog(`✅ 요금: ${finalResult.fareUsdc} USDC (${elapsedMinutes}분)`, "success");
      addLog(`✅ 환불: ${finalResult.refundUsdc} USDC`, "success");

      // elapsed 스냅샷 — clearSession() 전에 먼저 찍어야 localStorage가 살아있음
      const snapshotElapsed = elapsed > 0 ? elapsed : Math.floor((Date.now() - (getStartedAt() || Date.now())) / 1000);
      clearSession();
      setSessionData({ ...sessionData, result: { ...finalResult, elapsedSec: snapshotElapsed }, status: "ended" });
      setStep("ended");
      queryClient.invalidateQueries({ queryKey: ['sessions-history'] });
    } catch (err) {
      addLog(`❌ ${err.message}`, "error");
      setStep("active");
    } finally {
      setEnding(false);
    }
  };

  // ended 화면에서 "완료" 또는 홈 이동 시 localStorage 완전 정리
  const resetToHome = () => {
    clearSession();
    clearProc();
    setSessionData(null);
    sessionDataRef.current = null;
    setSelectedSvc(null);
    setStep("home");
    setElapsed(0);
    setTotalCharged(0);
    setLog([]);
    setEnding(false);
  };

  // 타이머: MM:SS 형식 유지 (경과 시간 정밀 표시)
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
            ⚠️ MetaMask가 연결되지 않았습니다.
            <button
              onClick={async () => {
                if (!window.ethereum) { alert("MetaMask 앱 브라우저에서 열어주세요."); return; }
                try {
                  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
                  const addr = accounts[0];
                  if (addr) { localStorage.setItem("mm_address", addr); setMmAddress(addr); }
                } catch { alert("MetaMask 연결을 거부하셨습니다."); }
              }}
              className="block mt-2 w-full text-center bg-orange-500 text-white py-2 rounded-xl font-semibold">
              MetaMask 연결하기
            </button>
          </div>
        )}

        {/* ── HOME ── */}
        {step === "home" && (
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
            {log.some(l => l.type === "error") ? (
              <button onClick={() => { clearProc(); setStep("home"); setLog([]); }}
                className="w-full py-3 bg-red-50 text-red-600 rounded-xl text-sm font-medium border border-red-100">
                ← 홈으로 돌아가기
              </button>
            ) : (
              <p className="text-xs text-gray-400">MetaMask 팝업이 뜨면 승인해주세요</p>
            )}
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
                  {/* 분 단위로 올라가는 요금 — ProposeUsageUpdate 주기와 일치 */}
                  <div className="text-xl font-bold">{liveCharged.toFixed(2)} USDC</div>
                  <div className="text-xs text-blue-200 mt-0.5">
                    USDC ({elapsedMinutes}분)
                  </div>
                  {/* 오프체인 서명 횟수 — 요금 스텝과 동기화 표시 */}
                  {elapsedMinutes > 0 && (
                    <div className="text-xs text-green-300 mt-1">🔏 서명 {elapsedMinutes}회</div>
                  )}
                </div>
                <div className="bg-white/10 rounded-xl p-3">
                  <div className="text-xl font-bold">{holdCountdown !== null ? (holdCountdown > 0 ? `${holdCountdown}s` : "✅") : "--"}</div>
                  <div className="text-xs text-blue-200 mt-0.5">홀드 잔여</div>
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl p-4 shadow-sm text-sm space-y-2">
              <div className="flex justify-between items-center text-gray-500">
                <span>세션 ID</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(sessionData?.sessionId || '');
                    alert('세션 ID가 복사되었습니다!');
                  }}
                  className="flex items-center gap-1 text-xs font-mono text-gray-700 hover:text-blue-600 active:text-blue-800 transition-colors"
                  title="클릭하여 복사"
                >
                  <span>{sessionData?.sessionId?.slice(0,14)}...</span>
                  <span className="text-gray-400 hover:text-blue-500">📋</span>
                </button>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>보증금</span>
                <span className="font-bold text-gray-800">{selectedSvc.depositUsdc} USDC</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>예상 환불</span>
                <span className="font-bold text-green-600">
                  {(selectedSvc.depositUsdc - liveCharged).toFixed(2)} USDC
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
              <p className="text-xs text-gray-400">환불 신청 시 세션 ID를 복사해 두세요 👆</p>
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
              <div className="flex justify-between py-2 border-b border-gray-50">
                <span className="text-gray-500">이용 시간</span>
                <span className="font-mono text-gray-900">{formatTime(sessionData?.result?.elapsedSec || elapsed || 0)}</span>
              </div>
              {/* 세션 ID — 환불 신청 시 필요 */}
              <div className="flex justify-between items-center py-2">
                <span className="text-gray-500">세션 ID</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(sessionData?.sessionId || '');
                    alert('세션 ID가 복사되었습니다!\n환불 신청 시 사용하세요.');
                  }}
                  className="flex items-center gap-1.5 bg-gray-50 hover:bg-blue-50 border border-gray-200 hover:border-blue-300 text-gray-700 hover:text-blue-700 rounded-lg px-2.5 py-1 transition-colors"
                  title="클릭하여 복사"
                >
                  <span className="font-mono text-xs">{sessionData?.sessionId?.slice(0,18)}…</span>
                  <span className="text-xs">📋</span>
                </button>
              </div>
            </div>

            {sessionData.result.txHash && sessionData.result.txHash !== 'settled_via_perun' && (
              <a href={`https://sepolia.basescan.org/tx/${sessionData.result.txHash}`}
                target="_blank" rel="noreferrer"
                className="block w-full text-center bg-gray-100 text-gray-600 py-3 rounded-xl text-sm hover:bg-gray-200 transition-colors">
                🔗 BaseScan에서 TX 확인
              </a>
            )}

            {/* 환불 신청 버튼 — 결제 완료 후 문제 발생 시 바로 환불 센터로 이동 */}
            <button
              onClick={() => navigate('/refund', {
                state: {
                  sessionId: sessionData?.sessionId,
                  reason: 'device_malfunction',
                }
              })}
              className="w-full bg-orange-50 border border-orange-200 text-orange-700 font-medium py-3 rounded-2xl text-sm">
              ⚠️ 문제가 있나요? 환불 신청
            </button>

            <button onClick={resetToHome}
              className="w-full bg-blue-600 text-white font-bold py-4 rounded-2xl shadow-lg">
              홈으로
            </button>
          </div>
        )}
      </div>
      <BottomNav />
    </div>
  );
}
