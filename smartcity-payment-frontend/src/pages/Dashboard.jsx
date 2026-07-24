import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { AlertTriangle, LogOut, ChevronRight, RefreshCw } from 'lucide-react';
import BottomNav from '@/components/wallet/BottomNav';
import BalanceCard from '@/components/wallet/BalanceCard';
import QuickActions from '@/components/wallet/QuickActions';
import { connectMetaMask, getUsdcBalance, clearMetaMaskStorage, getConnectedMetaMaskAddress } from '@/lib/walletUtils';
import { calcFare, calcRefund } from '@/lib/fareUtils';
import useMetaMaskProvider from '@/hooks/use-metamask-provider';

const BACKEND     = "https://payment-backend-production.up.railway.app";
const SESSION_KEY = "active_session";
const PROC_KEY    = "payment_processing";

const SERVICE_EMOJI = { bicycle: '🚲', ev_charging: '⚡', parking: '🅿️' };
const STATUS_COLOR  = {
  ACTIVE:          'text-blue-600',
  COMPLETED:       'text-green-600',
  REFUNDED:        'text-violet-400',
  SETTLING:        'text-orange-600',
  NEEDS_ATTENTION: 'text-red-500',
};

async function fetchRecentSessions(userAddress) {
  const res  = await fetch(`${BACKEND}/api/v1/sessions?userAddress=${userAddress}&limit=5`);
  const data = await res.json();
  return data.ok ? data.data : [];
}

export default function Dashboard() {
  const navigate     = useNavigate();
  const queryClient  = useQueryClient();
  const [showBalance,  setShowBalance]  = useState(true);
  const [mmAddress,    setMmAddress]    = useState(null);
  const [mmBalance,    setMmBalance]    = useState(null);
  const [mmConnecting, setMmConnecting] = useState(false);
  const [mmError,      setMmError]      = useState(null);
  const [activeSession,setActiveSession]= useState(null);
  const { provider, isDetecting, isMobile, deepLink } = useMetaMaskProvider();

  // 최근 세션 (결제 내역 미리보기)
  const { data: recentSessions = [], isFetching: sessionsFetching, refetch: refetchSessions } = useQuery({
    queryKey: ['sessions-recent', mmAddress],
    queryFn:  () => fetchRecentSessions(mmAddress),
    enabled:  !!mmAddress,
    staleTime: 30_000,
  });

  // MetaMask 동기화
  useEffect(() => {
    const syncMetaMask = async () => {
      const actualAddr = await getConnectedMetaMaskAddress();
      const storedAddr = localStorage.getItem("mm_address");
      if (!actualAddr) {
        if (storedAddr) { localStorage.removeItem("mm_address"); localStorage.removeItem("mm_balance"); }
        setMmAddress(null); setMmBalance(null);
      } else if (actualAddr.toLowerCase() === storedAddr?.toLowerCase()) {
        setMmAddress(actualAddr);
        getUsdcBalance(actualAddr).then(bal => { setMmBalance(bal); localStorage.setItem("mm_balance", bal); }).catch(() => {});
      } else {
        clearMetaMaskStorage(); setMmAddress(null); setMmBalance(null);
      }
    };
    if (isDetecting) return;
    syncMetaMask();
    if (provider) {
      const handler = () => { clearMetaMaskStorage(); setMmAddress(null); setMmBalance(null); };
      provider.on('accountsChanged', handler);
      return () => provider.removeListener('accountsChanged', handler);
    }
  }, [provider, isDetecting]);

  // 진행 중인 세션 복원 (active + processing 모두)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (saved?.sessionId && saved?.status === "active") { setActiveSession(saved); return; }
      // processing 중 나갔다가 메인으로 돌아온 경우도 표시
      const proc = JSON.parse(localStorage.getItem(PROC_KEY));
      if (proc?.sessionId && Date.now() - proc.savedAt < 10 * 60 * 1000) {
        setActiveSession({ ...proc, status: "processing" });
      }
    } catch {}
  }, []);

  // 잔액 주기적 갱신
  useEffect(() => {
    if (!mmAddress) return;
    const id = setInterval(() => {
      getUsdcBalance(mmAddress).then(bal => { setMmBalance(bal); localStorage.setItem("mm_balance", bal); }).catch(() => {});
    }, 15_000);
    return () => clearInterval(id);
  }, [mmAddress]);

  const handleConnectMetaMask = async () => {
    // 모바일 외부 브라우저라 provider가 없으면 MetaMask 앱으로 이동
    if (isMobile && !provider && !isDetecting) {
      window.location.href = deepLink;
      return;
    }
    setMmConnecting(true); setMmError(null);
    try {
      const addr = await connectMetaMask();
      if (addr) {
        setMmAddress(addr);
        localStorage.setItem("mm_address", addr);
        const bal = await getUsdcBalance(addr);
        setMmBalance(bal);
        localStorage.setItem("mm_balance", bal);
      }
    } catch (e) { setMmError(e.message || "MetaMask 연결 실패"); }
    finally      { setMmConnecting(false); }
  };

  const handleLogout = () => {
    clearMetaMaskStorage(); setMmAddress(null); setMmBalance(null);
    localStorage.removeItem(SESSION_KEY); localStorage.removeItem(PROC_KEY); setActiveSession(null);
  };

  const shortAddr = mmAddress ? `${mmAddress.slice(0,6)}...${mmAddress.slice(-4)}` : null;

  const formatDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4">

        {/* Header */}
        <div className="flex items-center justify-between pt-12 pb-4">
          <div>
            <p className="text-sm text-muted-foreground">BasePay Smart City</p>
            <h1 className="text-2xl font-bold">{mmAddress ? shortAddr : '지갑 미연결'}</h1>
          </div>
          {mmAddress && (
            <button onClick={handleLogout} className="p-2 rounded-full hover:bg-muted">
              <LogOut className="w-5 h-5 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* 진행 중 세션 배너 */}
        {activeSession && (
          <motion.div initial={{ opacity:0, y:-10 }} animate={{ opacity:1, y:0 }}
            className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-xl flex items-center gap-2">
            <div className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
            <span className="text-sm text-blue-800 flex-1">
              {SERVICE_EMOJI[activeSession.svc?.serviceType] || '📦'}{' '}
              {activeSession.status === "processing"
                ? `${activeSession.svc?.label || activeSession.svc?.serviceType} 결제 진행 중...`
                : `${activeSession.svc?.label || activeSession.svc?.serviceType} 이용 중`}
            </span>
            <button onClick={() => navigate('/scan')}
              className="text-xs text-blue-700 font-bold flex items-center gap-0.5">
              {activeSession.status === "processing" ? "재개하기" : "계속하기"} <ChevronRight className="w-3 h-3" />
            </button>
          </motion.div>
        )}

        {/* MetaMask 미연결 */}
        {!mmAddress && (
          <motion.div initial={{ opacity:0, y:10 }} animate={{ opacity:1, y:0 }}
            className="mb-4 p-4 bg-orange-50 border border-orange-200 rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <AlertTriangle className="w-5 h-5 text-orange-500" />
              <span className="text-sm font-semibold text-orange-800">MetaMask 연결 필요</span>
            </div>
            {isDetecting ? (
              <p className="text-xs text-orange-700 text-center py-2">MetaMask 확인 중...</p>
            ) : isMobile && !provider ? (
              <>
                <p className="text-xs text-orange-700 mb-3">
                  MetaMask 앱 내장 브라우저에서 접속하거나, 아래 버튼으로 MetaMask 앱을 열어주세요.
                </p>
                <a href={deepLink}
                  className="block w-full text-center py-2.5 bg-orange-500 text-white text-sm font-semibold rounded-lg">
                  MetaMask 앱에서 열기 →
                </a>
                <p className="text-xs text-orange-400 mt-2 text-center">
                  또는 MetaMask 앱 → 브라우저 탭 → 이 주소 직접 입력
                </p>
              </>
            ) : (
              <>
                <p className="text-xs text-orange-700 mb-3">결제 기능을 사용하려면 MetaMask를 연결해주세요.</p>
                {mmError && <p className="text-xs text-red-600 mb-2">{mmError}</p>}
                <button onClick={handleConnectMetaMask} disabled={mmConnecting}
                  className="w-full py-2 bg-orange-500 text-white text-sm font-semibold rounded-lg hover:bg-orange-600 disabled:opacity-50">
                  {mmConnecting ? '연결 중...' : 'MetaMask 연결'}
                </button>
              </>
            )}
          </motion.div>
        )}

        {/* 지갑 기능 */}
        {mmAddress && (
          <>
            <BalanceCard balance={mmBalance} address={mmAddress}
              showBalance={showBalance} onToggle={() => setShowBalance(b => !b)} />

            <QuickActions address={mmAddress} />
          </>
        )}

        {/* ── 최근 결제 내역 ───────────────────────────────────────── */}
        {mmAddress && (
          <div className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-gray-900">최근 결제 내역</h2>
              <div className="flex items-center gap-2">
                <button onClick={() => refetchSessions()}
                  className={`p-1 rounded-lg hover:bg-gray-100 ${sessionsFetching ? 'animate-spin' : ''}`}>
                  <RefreshCw className="w-3.5 h-3.5 text-gray-400" />
                </button>
                <button onClick={() => navigate('/history')}
                  className="text-xs text-blue-600 font-medium flex items-center gap-0.5">
                  전체보기 <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            </div>

            {recentSessions.length === 0 ? (
              <div className="bg-card border border-border rounded-2xl p-6 text-center">
                <div className="text-3xl mb-2">📭</div>
                <p className="text-sm text-muted-foreground">결제 내역이 없습니다</p>
                <button onClick={() => navigate('/scan')}
                  className="mt-3 text-blue-600 text-sm font-medium">첫 결제 시작하기</button>
              </div>
            ) : (
              <div className="space-y-2">
                {recentSessions.map((s, i) => {
                  const isRefunded = s.displayStatus === 'REFUNDED';
                  return (
                  <motion.div key={s.id}
                    initial={{ opacity:0, x:-10 }} animate={{ opacity:1, x:0 }}
                    transition={{ delay: i * 0.05 }}
                    className={`border rounded-xl flex items-center gap-3 p-3 ${
                      isRefunded ? 'bg-violet-500/10 border-violet-400/30' : 'bg-card border-border'
                    }`}>
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0 ${
                      isRefunded ? 'bg-violet-400/20' : 'bg-white'
                    }`}>
                      {s.serviceEmoji}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div className="text-sm font-semibold text-foreground truncate">{s.serviceLabel}</div>
                        {isRefunded && (
                          <span className="shrink-0 rounded-full bg-violet-400/20 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300">
                            환불 완료
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-gray-400">{formatDate(s.startedAt)}</div>
                    </div>
                    <div className="text-right flex-shrink-0">
                      <div className={`text-sm font-bold ${STATUS_COLOR[s.displayStatus] || 'text-gray-700'}`}>
                        {isRefunded
                          ? `+${calcRefund(s).toFixed(4)} USDC`
                          : s.displayStatus === 'ACTIVE'
                            ? `${parseFloat(s.depositUsdc||0).toFixed(2)} USDC`
                            : `-${calcFare(s).toFixed(4)} USDC`}
                      </div>
                      {isRefunded ? (
                        <div className="text-xs font-medium text-violet-300">전액 환불됨</div>
                      ) : s.displayStatus !== 'ACTIVE' && calcRefund(s) > 0 ? (
                        <div className="text-xs text-emerald-500">+{calcRefund(s).toFixed(4)} 잔액 반환</div>
                      ) : null}
                    </div>
                  </motion.div>
                  );
                })}
              </div>
            )}
          </div>
        )}

      </div>
      {mmAddress && <BottomNav />}
    </div>
  );
}


