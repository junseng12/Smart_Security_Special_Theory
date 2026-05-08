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
  if (!res.ok) throw new Error(data.error || data.message || "오류 발생");
  return data;
}

const REASONS = [
  { value: "service_failure",   label: "🔴 서비스 장애" },
  { value: "overcharge",        label: "💸 과금 오류" },
  { value: "duplicate_payment", label: "🔁 중복 결제" },
  { value: "unauthorized",      label: "🚫 미승인 결제" },
  { value: "other",             label: "📝 기타" },
];

const PROCESS_STEPS = [
  { icon: "📋", label: "신청서 접수" },
  { icon: "🔍", label: "에스크로 확인" },
  { icon: "⚖️", label: "판정 엔진 분석" },
  { icon: "💸", label: "USDC 환불 지급" },
];

export default function RefundCenter() {
  const navigate = useNavigate();
  const [tab, setTab] = useState("apply");
  const [form, setForm] = useState({
    sessionId: "", reason: "service_failure", amount: "", description: "",
  });
  const [caseId, setCaseId] = useState("");
  const [submitted, setSubmitted] = useState(null);
  const [lookupResult, setLookupResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // 내 트랜잭션에서 세션 자동 불러오기
  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions-all'],
    queryFn: () => base44.entities.Transaction.list('-created_date', 50),
  });
  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];
  const sessionTxs = transactions.filter(t => t.type === 'session_start' || t.type === 'payment');

  const submitRefund = async () => {
    setLoading(true); setError(null);
    try {
      const data = await apiCall("/api/v1/refunds", "POST", {
        sessionId: form.sessionId,
        userAddress: wallet?.address || "0x...",
        reason: form.reason,
        requestedAmount: form.amount,
        description: form.description,
      });
      setSubmitted(data);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const lookupCase = async () => {
    setLoading(true); setError(null); setLookupResult(null);
    try {
      const data = await apiCall(`/api/v1/refunds/${caseId}`);
      setLookupResult(data);
    } catch (e) { setError(e.message); }
    setLoading(false);
  };

  const resetApply = () => {
    setSubmitted(null);
    setForm({ sessionId: "", reason: "service_failure", amount: "", description: "" });
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
            <p className="text-xs text-muted-foreground">에스크로 기반 공정 환불</p>
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

              {/* 최근 결제 세션에서 선택 */}
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block uppercase tracking-wider font-medium">
                  세션 선택 *
                </label>
                {sessionTxs.length > 0 && (
                  <div className="space-y-2 mb-2">
                    {sessionTxs.slice(0, 4).map((tx) => (
                      <button key={tx.id}
                        onClick={() => setForm(p => ({ ...p, sessionId: tx.tx_hash }))}
                        className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition ${
                          form.sessionId === tx.tx_hash
                            ? "border-primary/50 bg-primary/5"
                            : "border-border bg-card hover:border-border/80"
                        }`}>
                        <div>
                          <p className="text-xs font-medium text-foreground">{tx.merchant_name}</p>
                          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                            {tx.tx_hash?.slice(0, 22)}...
                          </p>
                        </div>
                        <span className="text-xs text-accent font-medium shrink-0 ml-2">${tx.amount} USDC</span>
                      </button>
                    ))}
                  </div>
                )}
                <input value={form.sessionId}
                  onChange={e => setForm(p => ({ ...p, sessionId: e.target.value }))}
                  placeholder="세션 ID 직접 입력"
                  className="w-full bg-card border border-border rounded-xl p-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition font-mono"
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block uppercase tracking-wider font-medium">환불 사유 *</label>
                <select value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
                  className="w-full bg-card border border-border rounded-xl p-3 text-sm text-foreground focus:outline-none focus:border-primary/50 transition">
                  {REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block uppercase tracking-wider font-medium">환불 금액 (USDC) *</label>
                <input type="number" value={form.amount}
                  onChange={e => setForm(p => ({ ...p, amount: e.target.value }))}
                  placeholder="0.00"
                  className="w-full bg-card border border-border rounded-xl p-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition"
                />
              </div>

              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block uppercase tracking-wider font-medium">상세 설명</label>
                <textarea value={form.description}
                  onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                  placeholder="환불 사유를 자세히 설명해주세요..." rows={3}
                  className="w-full bg-card border border-border rounded-xl p-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition resize-none"
                />
              </div>

              <Button onClick={submitRefund}
                disabled={loading || !form.sessionId || !form.amount}
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

              <div className="rounded-2xl bg-card border border-border p-4 text-left space-y-2 text-sm font-mono mb-6">
                {[
                  ["케이스 ID", submitted?.caseId || submitted?.id || "생성 중..."],
                  ["상태",     "검토 중 (pending)"],
                  ["처리 예상", "24–48시간"],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-border pb-2 last:border-0 last:pb-0">
                    <span className="text-muted-foreground">{k}</span>
                    <span className={k === "상태" ? "text-yellow-400" : "text-foreground"}>{v}</span>
                  </div>
                ))}
              </div>

              <div className="space-y-2 text-left mb-6">
                {PROCESS_STEPS.map((s, i) => (
                  <div key={i} className={`flex items-center gap-3 p-3 rounded-xl border transition ${
                    i === 0 ? "bg-accent/5 border-accent/20 text-accent" :
                    i === 1 ? "bg-primary/5 border-primary/20 text-primary opacity-70" :
                    "bg-secondary/30 border-border text-muted-foreground opacity-40"
                  }`}>
                    <span>{i === 0 ? "✓" : s.icon}</span>
                    <span className="text-sm font-medium">{s.label}</span>
                    {i === 1 && <div className="ml-auto w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin" />}
                  </div>
                ))}
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
                  placeholder="케이스 ID 입력"
                  className="flex-1 bg-card border border-border rounded-xl p-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition"
                />
                <Button onClick={lookupCase} disabled={loading || !caseId}
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
                  <div className="flex items-center gap-2 mb-4">
                    <CheckCircle2 className="w-4 h-4 text-accent" />
                    <span className="text-sm font-semibold text-accent">케이스 발견</span>
                  </div>
                  <div className="space-y-2 text-sm font-mono mb-4">
                    {[
                      ["케이스 ID", lookupResult?.caseId || lookupResult?.id],
                      ["세션 ID",   lookupResult?.sessionId],
                      ["상태",      lookupResult?.status],
                      ["신청 금액", `${lookupResult?.requestedAmount || lookupResult?.amount || "-"} USDC`],
                      ["환불 금액", `${lookupResult?.refundAmount || "-"} USDC`],
                      ["결정",      lookupResult?.decision || "검토 중"],
                    ].filter(([, v]) => v).map(([k, v]) => (
                      <div key={k} className="flex justify-between border-b border-border pb-2 last:border-0">
                        <span className="text-muted-foreground">{k}</span>
                        <span className={k === "상태" ? "text-yellow-400" : "text-foreground"}>{v}</span>
                      </div>
                    ))}
                  </div>
                  <pre className="bg-background rounded-xl p-3 text-xs text-accent overflow-auto max-h-40 font-mono">
                    {JSON.stringify(lookupResult, null, 2)}
                  </pre>
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
