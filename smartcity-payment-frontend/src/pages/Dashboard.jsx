import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Zap, AlertTriangle, LogOut } from 'lucide-react';
import BottomNav from '@/components/wallet/BottomNav';
import BalanceCard from '@/components/wallet/BalanceCard';
import QuickActions from '@/components/wallet/QuickActions';
import RecentTransactions from '@/components/wallet/RecentTransactions';
import { connectMetaMask, getUsdcBalance, clearMetaMaskStorage, getConnectedMetaMaskAddress } from '@/lib/walletUtils';

const BACKEND = "https://payment-backend-production.up.railway.app";
const SESSION_KEY = "active_session";

export default function Dashboard() {
  const navigate = useNavigate();
  const [showBalance, setShowBalance] = useState(true);
  const [mmAddress, setMmAddress] = useState(null);
  const [mmBalance, setMmBalance] = useState(null);
  const [mmConnecting, setMmConnecting] = useState(false);
  const [mmError, setMmError] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    const syncMetaMask = async () => {
      const actualAddr = await getConnectedMetaMaskAddress();
      const storedAddr = localStorage.getItem("mm_address");

      if (!actualAddr) {
        if (storedAddr) {
          localStorage.removeItem("mm_address");
          localStorage.removeItem("mm_balance");
        }
        setMmAddress(null);
        setMmBalance(null);
      } else if (actualAddr.toLowerCase() === storedAddr?.toLowerCase()) {
        setMmAddress(actualAddr);
        getUsdcBalance(actualAddr).then(bal => {
          setMmBalance(bal);
          localStorage.setItem("mm_balance", bal);
        }).catch(() => {});
      } else {
        clearMetaMaskStorage();
        setMmAddress(null);
        setMmBalance(null);
      }
    };
    syncMetaMask();

    if (window.ethereum) {
      const onAccountsChanged = (accounts) => {
        if (!accounts || accounts.length === 0) {
          clearMetaMaskStorage();
          setMmAddress(null);
          setMmBalance(null);
        } else {
          clearMetaMaskStorage();
          setMmAddress(null);
          setMmBalance(null);
        }
      };
      window.ethereum.on('accountsChanged', onAccountsChanged);
      return () => window.ethereum.removeListener('accountsChanged', onAccountsChanged);
    }
  }, []);

  // 진행 중인 세션 복원
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (saved?.sessionData && saved?.service) setActiveSession(saved);
    } catch {}
  }, []);

  // MetaMask 주소가 있을 때 잔액 주기적 갱신
  useEffect(() => {
    if (!mmAddress) return;
    const interval = setInterval(() => {
      getUsdcBalance(mmAddress).then(bal => {
        setMmBalance(bal);
        localStorage.setItem("mm_balance", bal);
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, [mmAddress]);

  // 최근 트랜잭션 (payment-backend에서 조회)
  useEffect(() => {
    if (!mmAddress) return;
    fetch(`${BACKEND}/api/transactions/${mmAddress}`)
      .then(r => r.ok ? r.json() : [])
      .then(setTransactions)
      .catch(() => setTransactions([]));
  }, [mmAddress]);

  const handleConnectMetaMask = async () => {
    setMmConnecting(true);
    setMmError(null);
    try {
      const addr = await connectMetaMask();
      if (addr) {
        setMmAddress(addr);
        localStorage.setItem("mm_address", addr);
        const bal = await getUsdcBalance(addr);
        setMmBalance(bal);
        localStorage.setItem("mm_balance", bal);
      }
    } catch (e) {
      setMmError(e.message || "MetaMask 연결 실패");
    } finally {
      setMmConnecting(false);
    }
  };

  const handleLogout = () => {
    clearMetaMaskStorage();
    setMmAddress(null);
    setMmBalance(null);
    localStorage.removeItem(SESSION_KEY);
    setActiveSession(null);
  };

  const shortAddr = mmAddress
    ? `${mmAddress.slice(0, 6)}...${mmAddress.slice(-4)}`
    : null;

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4">
        {/* Header */}
        <div className="flex items-center justify-between pt-12 pb-4">
          <div>
            <p className="text-sm text-muted-foreground">BasePay Smart City</p>
            <h1 className="text-2xl font-bold">
              {mmAddress ? shortAddr : '지갑 미연결'}
            </h1>
          </div>
          {mmAddress && (
            <button onClick={handleLogout} className="p-2 rounded-full hover:bg-muted">
              <LogOut className="w-5 h-5 text-muted-foreground" />
            </button>
          )}
        </div>

        {/* 진행 중인 세션 배너 */}
        {activeSession && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-xl flex items-center gap-2"
          >
            <Zap className="w-4 h-4 text-yellow-600" />
            <span className="text-sm text-yellow-800 flex-1">
              {activeSession.service?.name || '서비스'} 이용 중
            </span>
            <button
              onClick={() => navigate('/scan')}
              className="text-xs text-yellow-700 font-medium underline"
            >
              계속하기
            </button>
          </motion.div>
        )}

        {/* MetaMask 연결 안 된 경우 */}
        {!mmAddress && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 p-4 bg-orange-50 border border-orange-200 rounded-xl"
          >
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 text-orange-500" />
              <span className="text-sm font-medium text-orange-800">MetaMask 연결 필요</span>
            </div>
            <p className="text-xs text-orange-700 mb-3">
              결제 기능을 사용하려면 MetaMask를 연결해주세요.
            </p>
            {mmError && <p className="text-xs text-red-600 mb-2">{mmError}</p>}
            <button
              onClick={handleConnectMetaMask}
              disabled={mmConnecting}
              className="w-full py-2 bg-orange-500 text-white text-sm font-medium rounded-lg hover:bg-orange-600 disabled:opacity-50"
            >
              {mmConnecting ? '연결 중...' : 'MetaMask 연결'}
            </button>
          </motion.div>
        )}

        {/* 잔액 카드 */}
        <BalanceCard
          balance={mmBalance}
          address={mmAddress}
          showBalance={showBalance}
          onToggle={() => setShowBalance(b => !b)}
        />

        {/* 빠른 액션 */}
        <QuickActions address={mmAddress} />

        {/* 최근 거래 */}
        <RecentTransactions transactions={transactions} />
      </div>
      <BottomNav />
    </div>
  );
}
