import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, Shield, Search, CheckCircle2, AlertCircle, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BottomNav from '@/components/wallet/BottomNav';
import { sendUsdcOnChain, getUsdcBalance } from '@/lib/walletUtils';

const BACKEND = "https://smartcity-payment-backend-production.up.railway.app";
// 환불 발송 주소 (에스크로 → 사용자): 실제로는 에스크로 컨트랙트가 해야 하지만
// 데모에서는 MetaMask 연결 주소(사용자)에서 다시 자신에게 보내는 것으로 시뮬레이션
// → 실제 환불은 백엔드가 처리해야 하므로 여기서는 "환불 승인됨" 표시 + DB 기록으로 처리

async function apiCall(path, method = "GET", body = null) {
  const res = await fetch(`${BACKEND}${path}`, {
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

const REASONS = [
  { value: "sensor_failure",    label: "📡 센서 장애" },
  { value: "double_charge",     label: "🔁 중복 결제" },
  { value: "service_outage",    label: "🔴 서비스 중단" },
  { value: "wrong_amount",      label: "💸 금액 오류" },
  { value: "device_malfunction",label: "🔧 기기 오작동" },
  { value: "manual_request",    label: "📝 수동 요청" },
];

export default function RefundCenter() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("apply");
  const [form, setForm] = useState({
    sessionId: "", channelId: "", reason: "sensor_failure", requestedUsdc: ""
  });
  const [caseId, setCaseId] = useState("");
  const [submitted, setSubmitted] = useState(null);
  const [lookupResult, setLookupResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions-all'],
    queryFn: () => base44.entities.Transaction.list('-created_date', 50),
  });
  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];
  const mmAddress = localStorage.getItem("mm_address");
  const sessionTxs = transactions.filter(t => t.type === 'session_start' || t.type === 'payment');

  // MetaMask 미연결 안내
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
        <Button onClick={() => navigate('/')} className="rounded-xl px-6">홈으로 돌아가기</Button>
        <BottomNav />
      </div>
    );
  }

  /**
   * 환불 신청 — 무조건 승인 처리:
   * 1) 백엔드에 환불 케이스 생성
   * 2) 백엔드 approve API 호출 (무조건)
   * 3) 환불 금액만큼 MetaMask → 사용자 본인 주소로 (실제로는 에스크로→사용자지만
   *    데모에서는 백엔드가 처리한다고 가정하고 DB에만 기록)
   *    ※ 실제 에스크로 컨트랙트가 없으므로 DB refund 트랜잭션 기록 + 잔액 반영
   */
  const submitRefund = async () => {
    setLoading(true);
    setError(null);
    try {
      const refundAmount = parseFloat(form.requestedUsdc) || 1.0;

      // 1) 백엔드 환불 케이스 생성
      const body = {
        userAddress: mmAddress,
        reason: form.reason,
        requestedUsdc: String(refundAmount),
      };
      if (form.sessionId) body.sessionId = form.sessionId;
      if (form.channelId) body.channelId = form.channelId;

      let caseData;
      try {
        caseData = await apiCall("/api/v1/refunds", "POST", body);
      } catch (e) {
        // 백엔드 오류 시 로컬 케이스 생성
        caseData = { id: `LOCAL-${Date.now()}`, status: "PENDING", reason: form.reason };
      }

      // 2) 무조건 승인 처리 (백엔드 approve API 시도)
      try {
        await apiCall(`/api/v1/refunds/${caseData.id}/approve`, "POST", {
          approvedUsdc: String(refundAmount),
          decision: "approved",
          notes: "Auto-approved for demo",
        });
      } catch {
        // approve 엔드포인트 없어도 계속 진행
      }

      // 3) DB에 환불 트랜잭션 기록 및 잔액 반영
      await base44.entities.Transaction.create({
        type: 'refund',
        amount: refundAmount,
        status: 'completed',
        to_address: mmAddress,
        from_address: 'escrow',
        merchant_name: `환불 — ${REASONS.find(r => r.value === form.reason)?.label || form.reason}`,
        tx_hash: caseData.id,
        wallet_id: wallet?.id,
        note: `케이스ID: ${caseData.id}`,
      });

      // 잔액 갱신 (온체인 실제 잔액 기준)
      const newBal = await getUsdcBalance(mmAddress);
      localStorage.setItem("mm_balance", newBal);
      if (wallet) {
        // 환불은 실제 온체인 전송이 아니므로 DB 잔액에만 반영
        await base44.entities.Wallet.update(wallet.id, {
          balance: (wallet.balance || 0) + refundAmount,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['transactions-all'] });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });

      setSubmitted({ ...caseData, status: "APPROVED", approvedUsdc: refundAmount });
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const lookupCase = async () => {
    setLoading(true);
    setError(null);
    setLookupResult(null);
    try {
      const data = await apiCall(`/api/v1/refunds/${caseId}`);
      setLookupResult(data);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const resetForm = () => {
    setSubmitted(null);
    setForm({ sessionId: "", channelId: "", reason: "sensor_failure", requestedUsdc: "" });
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
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
          {[["apply", "📋 환불 신청"], ["lookup", "🔍 케이스 조회"]].map(([key, label]) => (
            <button key={key}
              onClick={() => { setTab(key); setError(null); setSubmitted(null); setLookupResult(null); }}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
                tab === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}>{label}</button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {/* ── Apply Tab ── */}
          {tab === "apply" && !submitted && (
            <motion.div key="apply" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 10 }}
              className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" />{error}
                </div>
              )}

              {/* 세션 선택 */}
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block uppercase tracking-wider font-medium">세션 선택 (선택)</label>
                {sessionTxs.length > 0 && (
                  <div className="space-y-2 mb-2">
                    {sessionTxs.slice(0, 5).map(tx => (
                      <button key={tx.id}
                        onClick={() => setForm(p => ({ ...p, sessionId: tx.tx_hash, requestedUsdc: String(tx.amount || '') }))}
                        className={`w-full flex items-center justify-between p-3 rounded-xl border text-left transition ${
                          form.sessionId === tx.tx_hash
                            ? "border-primary/50 bg-primary/5"
                            : "border-border bg-card hover:border-border/80"
                        }`}>
                        <div>
                          <p className="text-xs font-medium">{tx.merchant_name}</p>
                          <p className="text-[10px] font-mono text-muted-foreground mt-0.5">{tx.tx_hash?.slice(0, 24)}...</p>
                        </div>
                        <span className="text-xs text-primary font-medium shrink-0 ml-2">{tx.amount} USDC</span>
                      </button>
                    ))}
                  </div>
                )}
                <input value={form.sessionId}
                  onChange={e => setForm(p => ({ ...p, sessionId: e.target.value }))}
                  placeholder="세션 ID 직접 입력"
                  className="w-full bg-card border border-border rounded-xl p-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition font-mono" />
              </div>

              {/* 환불 사유 */}
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block uppercase tracking-wider font-medium">환불 사유 *</label>
                <select value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))}
                  className="w-full bg-card border border-border rounded-xl p-3 text-sm text-foreground focus:outline-none focus:border-primary/50 transition">
                  {REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>

              {/* 환불 금액 */}
              <div>
                <label className="text-xs text-muted-foreground mb-1.5 block uppercase tracking-wider font-medium">환불 금액 (USDC) *</label>
                <div className="relative">
                  <input type="number" value={form.requestedUsdc}
                    onChange={e => setForm(p => ({ ...p, requestedUsdc: e.target.value }))}
                    placeholder="0.00"
                    step="0.01"
                    min="0.01"
                    className="w-full bg-card border border-border rounded-xl p-3 pr-16 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition" />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">USDC</span>
                </div>
              </div>

              <div className="rounded-xl bg-primary/5 border border-primary/20 p-3">
                <p className="text-xs text-primary font-medium mb-0.5">✅ 자동 승인 모드</p>
                <p className="text-xs text-muted-foreground">데모 환경에서는 모든 환불 신청이 즉시 승인되어 잔액에 반영됩니다.</p>
              </div>

              <Button onClick={submitRefund}
                disabled={loading || !form.reason || !form.requestedUsdc}
                className="w-full h-12 rounded-xl bg-primary hover:bg-primary/90 disabled:opacity-40">
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "🛡️ 환불 신청 제출"}
              </Button>
            </motion.div>
          )}

          {/* ── Submitted ── */}
          {tab === "apply" && submitted && (
            <motion.div key="submitted" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
              className="text-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="w-8 h-8 text-primary" />
              </div>
              <h2 className="text-xl font-bold mb-1">환불 승인 완료!</h2>
              <p className="text-sm text-muted-foreground mb-6">즉시 잔액에 반영되었습니다</p>
              <div className="rounded-2xl bg-card border border-border p-4 text-left space-y-2 text-sm font-mono mb-6">
                {[
                  ["케이스 ID", submitted?.id],
                  ["세션 ID", submitted?.session_id || form.sessionId || "-"],
                  ["사유", REASONS.find(r => r.value === (submitted?.reason || form.reason))?.label || form.reason],
                  ["상태", "✅ APPROVED"],
                  ["환불 금액", `${submitted?.approvedUsdc} USDC`],
                ].filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-border pb-2 last:border-0 last:pb-0">
                    <span className="text-muted-foreground">{k}</span>
                    <span className={k === "상태" ? "text-primary" : k === "환불 금액" ? "text-primary font-bold" : "text-foreground truncate max-w-[180px]"}>{v}</span>
                  </div>
                ))}
              </div>
              <Button variant="outline" onClick={resetForm} className="w-full rounded-xl">새 환불 신청</Button>
            </motion.div>
          )}

          {/* ── Lookup Tab ── */}
          {tab === "lookup" && (
            <motion.div key="lookup" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }}
              className="space-y-4">
              <div className="flex gap-2">
                <input value={caseId} onChange={e => setCaseId(e.target.value)}
                  placeholder="케이스 ID 입력"
                  className="flex-1 bg-card border border-border rounded-xl p-3 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 transition" />
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
                    <CheckCircle2 className="w-4 h-4 text-primary" />
                    <span className="text-sm font-semibold text-primary">케이스 발견</span>
                  </div>
                  <div className="space-y-2 text-sm font-mono mb-4">
                    {[
                      ["케이스 ID", lookupResult?.id],
                      ["세션 ID", lookupResult?.session_id],
                      ["사용자 주소", lookupResult?.user_address],
                      ["사유", lookupResult?.reason],
                      ["상태", lookupResult?.status],
                      ["신청 금액", lookupResult?.requested_usdc ? `${lookupResult.requested_usdc} USDC` : null],
                      ["승인 금액", lookupResult?.approved_usdc ? `${lookupResult.approved_usdc} USDC` : null],
                      ["결정", lookupResult?.decision || "검토 중"],
                    ].filter(([, v]) => v).map(([k, v]) => (
                      <div key={k} className="flex justify-between border-b border-border pb-2 last:border-0">
                        <span className="text-muted-foreground shrink-0 mr-2">{k}</span>
                        <span className={`${k === "상태" ? "text-yellow-400" : "text-foreground"} truncate max-w-[180px] text-right`}>{v}</span>
                      </div>
                    ))}
                  </div>
                  <details className="group">
                    <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground transition mb-2">원본 JSON 보기</summary>
                    <pre className="bg-background rounded-xl p-3 text-xs text-primary overflow-auto max-h-40 font-mono">
                      {JSON.stringify(lookupResult, null, 2)}
                    </pre>
                  </details>
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