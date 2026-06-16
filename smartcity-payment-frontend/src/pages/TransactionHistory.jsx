import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, RefreshCw, Search, ExternalLink, ChevronDown } from 'lucide-react';
import BottomNav from '@/components/wallet/BottomNav';

const BACKEND = "https://payment-backend-production.up.railway.app";

const STATUS_CONFIG = {
  Active:    { label: '이용 중',   color: 'bg-blue-100 text-blue-700',   dot: 'bg-blue-500'   },
  Ended:     { label: '종료됨',    color: 'bg-yellow-100 text-yellow-700',dot: 'bg-yellow-500' },
  Settling:  { label: '정산 중',   color: 'bg-orange-100 text-orange-700',dot: 'bg-orange-500' },
  Settled:   { label: '정산 완료', color: 'bg-green-100 text-green-700',  dot: 'bg-green-500'  },
  Disputed:  { label: '분쟁',      color: 'bg-red-100 text-red-700',      dot: 'bg-red-500'    },
  ForceClosed:{ label: '강제종료', color: 'bg-gray-100 text-gray-700',    dot: 'bg-gray-400'   },
};

const FILTERS = [
  { key: 'all',      label: '전체'   },
  { key: 'Active',   label: '이용 중' },
  { key: 'Settled',  label: '완료'   },
  { key: 'Settling', label: '정산 중' },
];

async function fetchSessions(userAddress, status) {
  const params = new URLSearchParams({ userAddress, limit: '50' });
  if (status !== 'all') params.set('status', status);
  const res = await fetch(`${BACKEND}/api/v1/sessions?${params}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '조회 실패');
  return data;
}

export default function TransactionHistory() {
  const navigate   = useNavigate();
  const mmAddress  = localStorage.getItem("mm_address");
  const [filter,   setFilter]   = useState('all');
  const [search,   setSearch]   = useState('');
  const [expanded, setExpanded] = useState(null);

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['sessions-history', mmAddress, filter],
    queryFn:  () => fetchSessions(mmAddress, filter),
    enabled:  !!mmAddress,
    staleTime: 30_000,
  });

  // fareUsdc가 0이면 started_at~ended_at 기준으로 프론트에서 재계산
  const RATE_PER_MIN = 0.1; // 0.1 USDC/분
  function calcFare(s) {
    const deposit = parseFloat(s.depositUsdc || 3.0);
    const fare    = parseFloat(s.fareUsdc || 0);
    if (fare > 0) return fare; // DB에 정상값 있으면 그대로
    // DB값이 0이면 시간 기반 재계산
    if (s.startedAt && s.endedAt) {
      const mins = (new Date(s.endedAt) - new Date(s.startedAt)) / 60000;
      const calc = Math.min(Math.round(mins * RATE_PER_MIN * 1_000_000) / 1_000_000, deposit);
      return calc;
    }
    return 0;
  }
  function calcRefund(s) {
    const deposit  = parseFloat(s.depositUsdc || 3.0);
    const refund   = parseFloat(s.refundUsdc || 0);
    if (refund > 0 && refund < deposit) return refund; // 정상값
    // 0이거나 deposit 전체 환불이면 fare 기반 재계산
    const fare = calcFare(s);
    return Math.max(0, deposit - fare);
  }

  const sessions = (data?.data || []).filter(s =>
    !search ||
    s.serviceLabel?.includes(search) ||
    s.id?.toLowerCase().includes(search.toLowerCase()) ||
    s.txHash?.toLowerCase().includes(search.toLowerCase())
  );

  const totalPaid   = sessions.reduce((a, s) => a + calcFare(s), 0);
  const totalRefund = sessions.reduce((a, s) => a + calcRefund(s), 0);

  const formatDate = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso);
    return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="max-w-md mx-auto px-4 pt-6 space-y-4">

        {/* Header */}
        <div className="flex items-center gap-3">
          <button onClick={() => navigate('/')}
            className="p-2 rounded-xl hover:bg-gray-100 transition-colors">
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-bold text-gray-900">사용 내역</h1>
            <p className="text-xs text-gray-400">{data?.total ?? 0}건의 세션</p>
          </div>
          <button onClick={() => refetch()}
            className={`p-2 rounded-xl hover:bg-gray-100 transition-colors ${isFetching ? 'animate-spin' : ''}`}>
            <RefreshCw className="w-4 h-4 text-gray-500" />
          </button>
        </div>

        {/* 통계 카드 */}
        {sessions.length > 0 && (
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-white rounded-2xl p-4 shadow-sm">
              <div className="text-xs text-gray-400 mb-1">총 결제</div>
              <div className="text-xl font-bold text-gray-900">{totalPaid.toFixed(4)}</div>
              <div className="text-xs text-gray-500">USDC</div>
            </div>
            <div className="bg-white rounded-2xl p-4 shadow-sm">
              <div className="text-xs text-gray-400 mb-1">총 환불</div>
              <div className="text-xl font-bold text-green-600">{totalRefund.toFixed(4)}</div>
              <div className="text-xs text-gray-500">USDC</div>
            </div>
          </div>
        )}

        {/* 검색 */}
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="세션 ID, TX 해시 검색..."
            className="w-full bg-white border border-gray-200 rounded-xl pl-10 pr-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:border-blue-300 transition shadow-sm" />
        </div>

        {/* 필터 탭 */}
        <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all border ${
                filter === f.key
                  ? 'bg-blue-600 text-white border-blue-600 shadow-sm'
                  : 'bg-white text-gray-500 border-gray-200 hover:border-blue-200'
              }`}>{f.label}</button>
          ))}
        </div>

        {/* 목록 */}
        {!mmAddress ? (
          <div className="bg-white rounded-2xl p-8 text-center shadow-sm">
            <p className="text-gray-400 text-sm">MetaMask를 먼저 연결해주세요</p>
            <button onClick={() => navigate('/')} className="mt-3 text-blue-600 text-sm font-medium">연결하러 가기</button>
          </div>
        ) : isLoading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="bg-red-50 rounded-2xl p-6 text-center text-red-600 text-sm">{error.message}</div>
        ) : sessions.length === 0 ? (
          <div className="bg-white rounded-2xl p-10 text-center shadow-sm">
            <div className="text-4xl mb-3">📭</div>
            <p className="text-gray-400 text-sm">내역이 없습니다</p>
          </div>
        ) : (
          <AnimatePresence>
            <div className="space-y-2">
              {sessions.map((s, i) => {
                const status = STATUS_CONFIG[s.status] || STATUS_CONFIG.Active;
                const isOpen = expanded === s.id;
                return (
                  <motion.div key={s.id}
                    initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.03 }}
                    className="bg-white rounded-2xl shadow-sm overflow-hidden">
                    {/* 헤더 행 */}
                    <button className="w-full flex items-center gap-3 p-4 text-left"
                      onClick={() => setExpanded(isOpen ? null : s.id)}>
                      <div className="text-2xl flex-shrink-0">{s.serviceEmoji}</div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-900 text-sm">{s.serviceLabel}</span>
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${status.color}`}>
                            {status.label}
                          </span>
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">{formatDate(s.startedAt)}</div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-bold text-gray-900 text-sm">
                          {(s.status === 'Active') ? `-${parseFloat(s.depositUsdc || 0).toFixed(2)}` : `-${calcFare(s).toFixed(4)}`}
                          <span className="text-xs text-gray-400 ml-0.5">USDC</span>
                        </div>
                        {s.status !== 'Active' && calcRefund(s) > 0 && (
                          <div className="text-xs text-green-600 font-medium">
                            +{calcRefund(s).toFixed(4)} 환불
                          </div>
                        )}
                      </div>
                      <ChevronDown className={`w-4 h-4 text-gray-300 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {/* 상세 (펼침) */}
                    {isOpen && (
                      <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }}
                        className="border-t border-gray-50 px-4 pb-4 pt-3 space-y-2 text-xs">
                        <div className="flex justify-between items-center text-gray-500">
                          <span>세션 ID</span>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(s.id || '');
                              alert('세션 ID 복사 완료!\n환불 신청 시 사용하세요.');
                            }}
                            className="flex items-center gap-1 font-mono text-gray-700 hover:text-blue-600 bg-gray-50 hover:bg-blue-50 border border-gray-200 hover:border-blue-300 rounded-lg px-2 py-0.5 transition-colors"
                            title="클릭하여 전체 ID 복사"
                          >
                            <span>{s.id.slice(0, 16)}…</span>
                            <span className="text-gray-400 text-xs">📋</span>
                          </button>
                        </div>
                        <div className="flex justify-between text-gray-500">
                          <span>보증금</span>
                          <span className="text-gray-700">{parseFloat(s.depositUsdc || 0).toFixed(2)} USDC</span>
                        </div>
                        {s.fareUsdc && (
                          <div className="flex justify-between text-gray-500">
                            <span>이용 요금</span>
                            <span className="text-gray-700">{parseFloat(s.fareUsdc).toFixed(6)} USDC</span>
                          </div>
                        )}
                        {s.refundUsdc && (
                          <div className="flex justify-between text-gray-500">
                            <span>환불 금액</span>
                            <span className="text-green-600 font-medium">{parseFloat(s.refundUsdc).toFixed(6)} USDC</span>
                          </div>
                        )}
                        <div className="flex justify-between text-gray-500">
                          <span>에스크로 상태</span>
                          <span className="text-gray-700">{s.escrowState || '-'}</span>
                        </div>
                        {s.txHash && s.txHash !== 'settled_via_perun' && (
                          <a href={`https://sepolia.basescan.org/tx/${s.txHash}`}
                            target="_blank" rel="noreferrer"
                            className="flex items-center gap-1 text-blue-600 hover:underline mt-1">
                            <ExternalLink className="w-3 h-3" />
                            <span>BaseScan에서 TX 확인</span>
                          </a>
                        )}
                      </motion.div>
                    )}
                  </motion.div>
                );
              })}
            </div>
          </AnimatePresence>
        )}
      </div>
      <BottomNav />
    </div>
  );
}
