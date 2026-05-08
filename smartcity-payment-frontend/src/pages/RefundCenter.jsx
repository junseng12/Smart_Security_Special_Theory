import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Shield, Search, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
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
    (data.errors && data.errors[0]) || data.error || "오류 발생"
  );
  return data.data ?? data;
}

// 백엔드 실제 허용 reason 값
const REASONS = [
  { value: "sensor_failure",    label: "🔴 센서/기기 장애" },
  { value: "double_charge",     label: "🔁 중복 결제" },
  { value: "service_outage",    label: "🚫 서비스 중단" },
  { value: "wrong_amount",      label: "💸 금액 오류" },
  { value: "device_malfunction",label: "⚙️ 단말기 오작동" },
  { value: "manual_request",    label: "📝 수동 환불 요청" },
];

const STATUS_LABEL = {
  RECEIVED:  { label: "접수됨",    color: "text-blue-400" },
  REVIEWING: { label: "검토 중",   color: "text-yellow-400" },
  APPROVED:  { label: "승인됨",    color: "text-accent" },
  REJECTED:  { label: "반려됨",    color: "text-destructive" },
  PAID:      { label: "지급 완료", color: "text-accent" },
};

export default function RefundCenter() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("apply");
  const [form, setForm] = useState({ sessionId: "", reason: "sensor_failure" });
  const [caseId, setCaseId] = useState("");
  const [submitted, setSubmitted] = useState(null);
  const [lookupResult, setLookupResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];

  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions-refund'],
    queryFn: () => base44.entities.Transaction.list(),
  });
  // session_start 타입 거래만 (환불 신청 대상)
  const sessionTxs = transactions.filter(t => t.type === 'session_start' || t.type === 'payment');

  const submitRefund = async () => {
    if (!form.sessionId) { setError("세션 ID를 선택하거나 입력해주세요."); return; }
    setLoading(true); setError(null);
    try {
      const data = await apiCall("/api/v1/refunds", "POST", {
        sessionId: form.sessionId,
        userAddress: wallet?.address || "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7",
        reason: form.reason,
      });
      setSubmitted(data);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const lookupCase = async () => {
    if (!caseId.trim()) return;
    setLoading(true); setError(null); setLookupResult(null);
    try {
      const data = await apiCall(`/api/v1/refunds/${caseId.trim()}`);
      setLookupResult(data);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const resetApply = () => {
    setSubmitted(null);
    setForm({ sessionId: "", reason: "sensor_failure" });
    setError(null);
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">

        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold">환불 센터</h1>
            <p className="text-xs text-muted-foreground">에스크로 기반 공정 환불 처리</p>
          </div>
          <Shield className="w-5 h-5 text-accent" />
        </div>

        {/* Tabs */}
        <div className="flex bg-secondary/50 rounded-xl p-1 mb-6">
          {[["apply", "📋 환불 신청"], ["lookup", "🔍 케이스 조회"]].map(([key, label]) => (
            <button key={key}
              onClick={() => { setTab(key); setError(null); setSubmitted(null); setLookupResult(null); }}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                tab === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}>{label}</button>
          ))}
        </div>

        <AnimatePresence mode="wait">

          {/* ── 신청 탭 ── */}
          {tab === "apply" && !submitted && (
            <motion.div key="apply"
              initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}
              className="space-y-4">

              {error && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}

              {/* 최근 결제에서 선택 */}
              <div>
                <label className="text-xs text-muted-foreground mb-2 block uppercase tracking-wider font-medium">
                  결제 세션 선택 *
                </label>
                {sessionTxs.length > 0 ? (
                  <div className="space-y-2 mb-2">
                    {sessionTxs.slice(0, 5).map((tx) => (
                      <button key={tx.id}
                        onClick={() => setForm(p => ({ ...p, sessionId: tx.tx_hash }))}
                        className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition ${
                          form.sessionId === tx.tx_hash
                            ? "border-primary/60 bg-primary/5"
                            : "border-border bg-card hover:border-border/80"
                        }`}>
                        <div>
                          <p className="text-xs font-semibold">{tx.merchant_name}</p>
                          <p className="text-[10px] font-mono text-muted-foreground mt-0.5 truncate max-w-[200px]">
                            {tx.tx_hash}
                          </p>
                        </div>
                        <span className="text-xs text-accent font-medium shrink-0 ml-2">
                          {tx.amount} USDC
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground mb-2 p-3 rounded-xl bg-secondary/30 border border-border">
                    결제 내역이 없습니다. 세션 ID를 직접 입력하세요.
                  </p>
                )}
                <input value={form.sessionId}
                  onChange={e => setForm(p => ({ ...p, sessionId: e.target.value }))}
                  placeholder="세션 ID 직접 입력 (예: c7e7e03d-94b5-...)"
                  className="w-full bg-card border border-border rounded-xl p-3 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition font-mono"
                />
              </div>

              {/* 환불 사유 */}
              <div>
                <label className="text-xs text-muted-foreground mb-2 block uppercase tracking-wider font-medium">
                  환불 사유 *
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {REASONS.map(r => (
                    <button key={r.value}
                      onClick={() => setForm(p => ({ ...p, reason: r.value }))}
                      className={`p-3 rounded-xl border text-left transition text-xs ${
                        form.reason === r.value
                          ? "border-primary/60 bg-primary/5 text-foreground"
                          : "border-border bg-card text-muted-foreground hover:text-foreground"
                      }`}>
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>

              <Button onClick={submitRefund} disabled={loading || !form.sessionId}
                className="w-full h-12 rounded-xl bg-primary hover:bg-primary/90 disabled:opacity-40">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "🛡️ 환불 신청 제출"}
              </Button>
            </motion.div>
          )}

          {/* ── 신청 완료 ── */}
          {tab === "apply" && submitted && (
            <motion.div key="submitted"
              initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
              className="text-center">
              <div className="w-16 h-16 rounded-full bg-accent/10 flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-8 h-8 text-accent" />
              </div>
              <h2 className="text-xl font-bold mb-1">신청 완료</h2>
              <p className="text-sm text-muted-foreground mb-6">케이스가 생성되었습니다</p>

              <div className="rounded-2xl bg-card border border-border p-4 text-left space-y-3 text-sm font-mono mb-4">
                {[
                  ["케이스 ID", submitted?.caseId || submitted?.id],
                  ["상태",     "RECEIVED"],
                  ["처리 예상", "24–48시간"],
                ].map(([k, v]) => v && (
                  <div key={k} className="flex justify-between border-b border-border pb-2 last:border-0 last:pb-0">
                    <span className="text-muted-foreground">{k}</span>
                    <span className={k === "상태" ? "text-blue-400" : "text-foreground"}>{v}</span>
                  </div>
                ))}
              </div>

              <div className="rounded-2xl bg-secondary/30 border border-border p-3 text-left mb-6">
                <p className="text-xs text-muted-foreground mb-1 font-medium">📋 케이스 ID 저장</p>
                <p className="text-xs font-mono text-accent break-all">{submitted?.caseId || submitted?.id}</p>
                <p className="text-[10px] text-muted-foreground mt-1">조회 탭에서 이 ID로 상태를 확인하세요.</p>
              </div>

              <Button variant="outline" onClick={resetApply} className="w-full rounded-xl">
                새 환불 신청
              </Button>
            </motion.div>
          )}

          {/* ── 케이스 조회 탭 ── */}
          {tab === "lookup" && (
            <motion.div key="lookup"
              initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }}
              className="space-y-4">

              <div className="flex gap-2">
                <input value={caseId} onChange={e => setCaseId(e.target.value)}
                  placeholder="케이스 ID (예: case_749fdc45)"
                  className="flex-1 bg-card border border-border rounded-xl p-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition"
                />
                <Button onClick={lookupCase} disabled={loading || !caseId.trim()}
                  className="rounded-xl px-4 bg-primary hover:bg-primary/90 disabled:opacity-40">
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                </Button>
              </div>

              {error && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}

              {lookupResult && (
                <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                  className="rounded-2xl bg-card border border-border p-4">
                  {/* 상태 배지 */}
                  {(() => {
                    const s = STATUS_LABEL[lookupResult.status] || { label: lookupResult.status, color: "text-foreground" };
                    return (
                      <div className="flex items-center justify-between mb-4">
                        <span className="text-sm font-semibold">케이스 상세</span>
                        <span className={`text-xs font-bold px-2 py-1 rounded-full bg-secondary/50 ${s.color}`}>
                          {s.label}
                        </span>
                      </div>
                    );
                  })()}

                  <div className="space-y-2 text-xs font-mono mb-4">
                    {[
                      ["케이스 ID",  lookupResult?.id],
                      ["세션 ID",    lookupResult?.session_id],
                      ["사용자",     lookupResult?.user_address?.slice(0, 16) + "..."],
                      ["사유",       REASONS.find(r => r.value === lookupResult?.reason)?.label || lookupResult?.reason],
                      ["신청 금액",  lookupResult?.requested_usdc ? `${lookupResult.requested_usdc} USDC` : "-"],
                      ["승인 금액",  lookupResult?.approved_usdc ? `${lookupResult.approved_usdc} USDC` : "-"],
                      ["신청일",     lookupResult?.created_at ? new Date(lookupResult.created_at).toLocaleString('ko-KR') : "-"],
                    ].filter(([,v]) => v).map(([k, v]) => (
                      <div key={k} className="flex justify-between border-b border-border pb-1.5 last:border-0">
                        <span className="text-muted-foreground">{k}</span>
                        <span className="text-foreground text-right max-w-[180px] truncate">{v}</span>
                      </div>
                    ))}
                  </div>

                  {lookupResult?.reviewer_notes && (
                    <div className="rounded-xl bg-secondary/30 p-3">
                      <p className="text-xs text-muted-foreground mb-1">검토 메모</p>
                      <p className="text-xs">{lookupResult.reviewer_notes}</p>
                    </div>
                  )}
                </motion.div>
              )}
            </motion.div>
          )}

        </AnimatePresence>
      </div>
      <BottomNav />
    </div>
  );
}
