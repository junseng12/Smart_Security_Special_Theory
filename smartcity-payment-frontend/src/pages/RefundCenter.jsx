import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft, Shield, Search, CheckCircle2, AlertCircle,
  Loader2, Lock, RefreshCw, Clock, ChevronRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import BottomNav from '@/components/wallet/BottomNav';

// ── 백엔드 API ────────────────────────────────────────────────────────────────
const BACKEND = "https://payment-backend-production.up.railway.app";

async function apiCall(path, method = "GET", body = null) {
  const res = await fetch(BACKEND + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) throw new Error(
    data.errors?.[0] || data.error || "오류 발생"
  );
  return data.data ?? data;
}

// ── 환불 사유 목록 ────────────────────────────────────────────────────────────
const REASONS = [
  { value: "unlock_failure",    label: "🔒 잠금 해제 실패",  hint: "자전거/기기가 잠금 해제되지 않음 (전액 환불)" },
  { value: "sensor_failure",    label: "📡 센서 장애",       hint: "이용 중 센서 오류로 과다 청구" },
  { value: "double_charge",     label: "🔁 중복 결제",       hint: "동일 세션에 요금이 두 번 청구됨" },
  { value: "service_outage",    label: "🔴 서비스 중단",     hint: "서비스 중단으로 이용 불가 (전액 환불)" },
  { value: "wrong_amount",      label: "💸 금액 오류",       hint: "표시 금액과 실제 청구 금액 불일치" },
  { value: "device_malfunction",label: "🔧 기기 오작동",     hint: "이용 중 기기 결함 발생" },
  { value: "manual_request",    label: "📝 기타 / 직접 입력", hint: "기타 환불 사유" },
];

// ── 상태 배지 색상 ────────────────────────────────────────────────────────────
const STATUS_STYLE = {
  RECEIVED:  "bg-gray-100 text-gray-600",
  EVALUATING:"bg-blue-100 text-blue-700",
  APPROVED:  "bg-green-100 text-green-700",
  REJECTED:  "bg-red-100  text-red-700",
  PAID:      "bg-purple-100 text-purple-700",
  CLOSED:    "bg-gray-100 text-gray-500",
};
const STATUS_KO = {
  RECEIVED:  "접수됨",
  EVALUATING:"심사중",
  APPROVED:  "승인됨",
  REJECTED:  "거절됨",
  PAID:      "지급완료",
  CLOSED:    "처리완료",
};

export default function RefundCenter() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const queryClient = useQueryClient();

  const [tab, setTab]       = useState("apply");   // "apply" | "history"
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);
  const [submitted, setSubmitted] = useState(null);

  // 환불 신청 폼
  const [form, setForm] = useState({
    reason: "sensor_failure",
    sessionId: "",
    requestedUsdc: "",
    note: "",
  });

  // 케이스 목록
  const [cases, setCases] = useState([]);
  const [casesLoading, setCasesLoading] = useState(false);

  const mmAddress = localStorage.getItem("mm_address");

  // 활성 세션이 있으면 폼에 sessionId 자동 입력
  React.useEffect(() => {
    if (form.sessionId) return; // 이미 입력된 경우 스킵
    try {
      const active = JSON.parse(localStorage.getItem("active_session") || "{}");
      if (active?.sessionId) {
        setForm(f => ({ ...f, sessionId: active.sessionId }));
      }
    } catch {}
  }, []); // eslint-disable-line

  // location.state로 세션 정보 자동 입력 (ScanPay → 환불센터 이동 시)
  useEffect(() => {
    if (location.state?.sessionId) {
      setForm(f => ({ ...f, sessionId: location.state.sessionId }));
    }
    if (location.state?.reason) {
      setForm(f => ({ ...f, reason: location.state.reason }));
    }
  }, [location.state]);

  // 케이스 목록 로드
  const loadCases = async () => {
    if (!mmAddress) return;
    setCasesLoading(true);
    try {
      const data = await apiCall(`/api/v1/refunds?userAddress=${mmAddress}&limit=20`);
      setCases(Array.isArray(data) ? data : []);
    } catch (e) {
      setCases([]);
    } finally {
      setCasesLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "history") loadCases();
  }, [tab]); // eslint-disable-line

  // MetaMask 미연결
  if (!mmAddress) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
        <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center mb-4">
          <Lock className="w-8 h-8 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-semibold mb-2">MetaMask 연결 필요</h2>
        <p className="text-sm text-muted-foreground text-center mb-6">
          환불 센터는 MetaMask 연결 후 이용할 수 있습니다.
        </p>
        <Button onClick={() => navigate("/")} className="rounded-xl px-6">홈으로 돌아가기</Button>
        <BottomNav />
      </div>
    );
  }

  // ── 환불 신청 제출 ──────────────────────────────────────────────────────────
  const submitRefund = async () => {
    if (!form.reason) { setError("환불 사유를 선택해주세요."); return; }
    setLoading(true);
    setError(null);
    try {
      // 1) 환불 케이스 생성
      const body = {
        userAddress:   mmAddress,
        reason:        form.reason,
        ...(form.sessionId    && { sessionId:    form.sessionId }),
        ...(form.requestedUsdc && { requestedUsdc: form.requestedUsdc }),
        evidence: form.note ? [{ type: "user_note", note: form.note }] : [],
      };
      const caseData = await apiCall("/api/v1/refunds", "POST", body);

      // 2) 자동 심사 요청 (백엔드 evaluate)
      let decision = null;
      try {
        decision = await apiCall(`/api/v1/refunds/${caseData.id}/evaluate`, "POST");
      } catch {}

      // 3) 자동 승인됐으면 → payout 요청 (세션ID 있는 경우 온체인 처리)
      let paidOut = false;
      let payoutTxHash = null;
      if ((decision?.decision === "auto_approved" || decision?.decision === "manual_required") && form.sessionId) {
        try {
          // auto_approved: 즉시 payout / manual_required: 승인 후 payout
          // 우선 approve 시도 (이미 승인됐을 수 있음)
          if (decision?.decision === "manual_required") {
            try {
              await apiCall(`/api/v1/refunds/${caseData.id}/approve`, "POST", {
                approvedUsdc: String(parseFloat(form.requestedUsdc) || "3.000000"),
                reviewerNotes: "Auto-approved after evaluation",
              });
            } catch {}
          }
          const payoutResult = await apiCall(`/api/v1/refunds/${caseData.id}/payout`, "POST", {
            sessionId: form.sessionId,
          });
          paidOut = true;
          payoutTxHash = payoutResult?.txHash || null;
        } catch (payoutErr) {
          console.warn("payout 실패 (수동 처리 필요):", payoutErr.message);
        }
      } else if (decision?.decision === "auto_approved" && !form.sessionId) {
        // sessionId 없으면 승인만 처리
        try {
          await apiCall(`/api/v1/refunds/${caseData.id}/approve`, "POST", {
            approvedUsdc: String(parseFloat(form.requestedUsdc) || "3.000000"),
            reviewerNotes: "Auto-approved — no sessionId for on-chain",
          });
        } catch {}
      }

      setSubmitted({ ...caseData, decision, paidOut, payoutTxHash });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate("/")}
            className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold">환불 센터</h1>
            <p className="text-xs text-muted-foreground">에스크로 기반 공정 환불</p>
          </div>
          <Shield className="w-5 h-5 text-primary" />
        </div>

        {/* Tabs */}
        <div className="flex bg-secondary/50 rounded-xl p-1 mb-6">
          {[["apply","📋 환불 신청"],["history","📂 내 케이스"]].map(([key, label]) => (
            <button key={key}
              onClick={() => { setTab(key); setError(null); setSubmitted(null); }}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                tab === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              }`}>{label}</button>
          ))}
        </div>

        <AnimatePresence mode="wait">

          {/* ── 환불 신청 탭 ──────────────────────────────────────────────── */}
          {tab === "apply" && !submitted && (
            <motion.div key="apply" initial={{ opacity:0, x:-10 }} animate={{ opacity:1, x:0 }} exit={{ opacity:0 }}
              className="space-y-4">

              {/* 세션 ID (선택) */}
              <div className="bg-card border rounded-xl p-4">
                <label className="text-xs text-muted-foreground mb-2 block font-medium uppercase tracking-wide">
                  세션 ID <span className="text-muted-foreground font-normal">(선택 — 있으면 자동 처리)</span>
                </label>
                <input
                  value={form.sessionId}
                  onChange={e => setForm(f => ({ ...f, sessionId: e.target.value }))}
                  placeholder="ex) 결제 완료 후 받은 세션 ID"
                  className="w-full text-sm bg-transparent outline-none placeholder:text-muted-foreground/50"
                />
              </div>

              {/* 환불 사유 */}
              <div className="bg-card border rounded-xl p-4">
                <label className="text-xs text-muted-foreground mb-3 block font-medium uppercase tracking-wide">
                  환불 사유 *
                </label>
                <div className="space-y-2">
                  {REASONS.map(r => (
                    <button key={r.value}
                      onClick={() => setForm(f => ({ ...f, reason: r.value }))}
                      className={`w-full text-left px-3 py-2.5 rounded-lg border text-sm transition ${
                        form.reason === r.value
                          ? "border-primary bg-primary/5 text-foreground"
                          : "border-transparent bg-secondary/50 text-muted-foreground hover:bg-secondary"
                      }`}>
                      <div className="font-medium">{r.label}</div>
                      <div className="text-xs opacity-70 mt-0.5">{r.hint}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* 요청 금액 */}
              <div className="bg-card border rounded-xl p-4">
                <label className="text-xs text-muted-foreground mb-2 block font-medium uppercase tracking-wide">
                  요청 금액 (USDC) <span className="font-normal">(선택)</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number" min="0" step="0.01"
                    value={form.requestedUsdc}
                    onChange={e => setForm(f => ({ ...f, requestedUsdc: e.target.value }))}
                    placeholder="0.00"
                    className="flex-1 text-sm bg-transparent outline-none"
                  />
                  <span className="text-sm text-muted-foreground">USDC</span>
                </div>
              </div>

              {/* 메모 */}
              <div className="bg-card border rounded-xl p-4">
                <label className="text-xs text-muted-foreground mb-2 block font-medium uppercase tracking-wide">
                  추가 설명 <span className="font-normal">(선택)</span>
                </label>
                <textarea
                  value={form.note}
                  onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                  placeholder="구체적인 상황을 적어주시면 빠른 처리에 도움이 됩니다."
                  rows={3}
                  className="w-full text-sm bg-transparent outline-none resize-none placeholder:text-muted-foreground/50"
                />
              </div>

              {/* 에러 */}
              {error && (
                <div className="flex items-center gap-2 text-red-500 text-sm bg-red-50 p-3 rounded-xl">
                  <AlertCircle className="w-4 h-4 flex-shrink-0" />
                  {error}
                </div>
              )}

              {/* 안내 */}
              <div className="bg-blue-50 border border-blue-100 rounded-xl p-3 text-xs text-blue-700 space-y-1">
                <p className="font-medium">처리 흐름</p>
                <p>① 케이스 접수 → ② 자동 심사 → ③ 승인 시 에스크로 컨트랙트에서 온체인 환불</p>
                <p className="text-blue-500">세션 ID가 있으면 자동 심사 및 즉시 처리됩니다.</p>
              </div>

              <Button onClick={submitRefund} disabled={loading} className="w-full rounded-xl h-12 text-base">
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                {loading ? "처리 중..." : "환불 신청하기"}
              </Button>
            </motion.div>
          )}

          {/* ── 신청 완료 ─────────────────────────────────────────────────── */}
          {tab === "apply" && submitted && (
            <motion.div key="done" initial={{ opacity:0, scale:0.97 }} animate={{ opacity:1, scale:1 }}
              className="text-center py-8 space-y-4">
              <div className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center ${
                submitted.paidOut ? "bg-purple-100" : "bg-green-100"
              }`}>
                <CheckCircle2 className={`w-8 h-8 ${submitted.paidOut ? "text-purple-600" : "text-green-600"}`} />
              </div>
              <div>
                <h2 className="text-lg font-bold mb-1">
                  {submitted.paidOut ? "환불 완료! 🎉" : "환불 접수 완료"}
                </h2>
                <p className="text-sm text-muted-foreground">케이스 ID: {submitted.id}</p>
              </div>

              {submitted.paidOut && (
                <div className="bg-purple-50 border border-purple-100 rounded-xl p-4 text-sm text-purple-800 text-left">
                  <p className="font-semibold mb-2">온체인 환불 처리됨 ✅</p>
                  <p className="mb-2">에스크로 컨트랙트에서 지갑으로 직접 전송되었습니다.</p>
                  {submitted.payoutTxHash && (
                    <a
                      href={`https://sepolia.basescan.org/tx/${submitted.payoutTxHash}`}
                      target="_blank" rel="noopener noreferrer"
                      className="text-xs font-mono bg-purple-100 px-2 py-1 rounded break-all hover:underline block mt-1"
                    >
                      TX: {submitted.payoutTxHash.slice(0,20)}...
                    </a>
                  )}
                </div>
              )}

              {!submitted.paidOut && (
                <div className="bg-blue-50 border border-blue-100 rounded-xl p-4 text-sm text-blue-800 space-y-1">
                  <p className="font-semibold">심사 진행 중</p>
                  <p>운영팀이 검토 후 처리합니다. 결과는 &quot;내 케이스&quot;에서 확인하세요.</p>
                  {submitted.decision?.decision === "manual_required" && (
                    <p className="text-xs text-blue-600 mt-1">※ 수동 검토가 필요한 케이스입니다.</p>
                  )}
                </div>
              )}

              <div className="flex gap-3">
                <Button variant="outline" onClick={() => { setSubmitted(null); setForm({ reason:"sensor_failure", sessionId:"", requestedUsdc:"", note:"" }); }}
                  className="flex-1 rounded-xl">새 신청</Button>
                <Button onClick={() => setTab("history")} className="flex-1 rounded-xl">
                  내 케이스 보기
                </Button>
              </div>
            </motion.div>
          )}

          {/* ── 케이스 내역 탭 ────────────────────────────────────────────── */}
          {tab === "history" && (
            <motion.div key="history" initial={{ opacity:0, x:10 }} animate={{ opacity:1, x:0 }} exit={{ opacity:0 }}>
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm text-muted-foreground">{cases.length}개 케이스</p>
                <button onClick={loadCases}
                  className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                  <RefreshCw className="w-3 h-3" />새로고침
                </button>
              </div>

              {casesLoading && (
                <div className="flex justify-center py-12">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              )}

              {!casesLoading && cases.length === 0 && (
                <div className="text-center py-12 text-muted-foreground text-sm">
                  <Shield className="w-10 h-10 mx-auto mb-3 opacity-30" />
                  <p>접수된 환불 케이스가 없습니다.</p>
                </div>
              )}

              <div className="space-y-3">
                {cases.map(c => (
                  <motion.div key={c.id} initial={{ opacity:0, y:4 }} animate={{ opacity:1, y:0 }}
                    className="bg-card border rounded-xl p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <p className="text-sm font-semibold">{REASONS.find(r => r.value === c.reason)?.label || c.reason}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{c.id}</p>
                      </div>
                      <span className={`text-xs px-2 py-1 rounded-full font-medium ${STATUS_STYLE[c.status] || "bg-gray-100 text-gray-600"}`}>
                        {STATUS_KO[c.status] || c.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground">
                      {c.requested_usdc && <span>요청: {c.requested_usdc} USDC</span>}
                      {c.approved_usdc  && <span className="text-green-600">승인: {c.approved_usdc} USDC</span>}
                      {c.created_at     && (
                        <span className="flex items-center gap-0.5">
                          <Clock className="w-3 h-3" />
                          {new Date(c.created_at).toLocaleDateString("ko-KR")}
                        </span>
                      )}
                    </div>
                    {c.reviewer_notes && (
                      <p className="mt-2 text-xs text-muted-foreground bg-secondary/50 rounded-lg px-3 py-2">
                        {c.reviewer_notes}
                      </p>
                    )}
                    {/* APPROVED지만 payout 안된 경우 수동 payout 버튼 */}
                    {c.status === "APPROVED" && c.session_id && (
                      <PayoutButton caseId={c.id} sessionId={c.session_id} onDone={loadCases} />
                    )}
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </div>
      <BottomNav />
    </div>
  );
}

// ── 개별 payout 버튼 ─────────────────────────────────────────────────────────
function PayoutButton({ caseId, sessionId, onDone }) {
  const [loading, setLoading] = useState(false);
  const [done, setDone]       = useState(false);
  const [err, setErr]         = useState(null);

  const doPayout = async () => {
    setLoading(true);
    setErr(null);
    try {
      await fetch(`https://payment-backend-production.up.railway.app/api/v1/refunds/${caseId}/payout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      }).then(r => r.json()).then(d => {
        if (!d.ok) throw new Error(d.error || "지급 실패");
      });
      setDone(true);
      onDone?.();
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  if (done) return (
    <div className="mt-2 text-xs text-green-600 flex items-center gap-1">
      <CheckCircle2 className="w-3 h-3" /> 온체인 환불 완료
    </div>
  );

  return (
    <div className="mt-2">
      {err && <p className="text-xs text-red-500 mb-1">{err}</p>}
      <button onClick={doPayout} disabled={loading}
        className="text-xs text-primary font-medium flex items-center gap-1 hover:underline">
        {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <ChevronRight className="w-3 h-3" />}
        {loading ? "처리 중..." : "온체인 환불 실행"}
      </button>
    </div>
  );
}

