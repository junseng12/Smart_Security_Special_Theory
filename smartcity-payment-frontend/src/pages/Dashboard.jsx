import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Zap, AlertTriangle, LogOut } from 'lucide-react';
import BottomNav from '@/components/wallet/BottomNav';
import BalanceCard from '@/components/wallet/BalanceCard';
import QuickActions from '@/components/wallet/QuickActions';
import RecentTransactions from '@/components/wallet/RecentTransactions';
import { connectMetaMask, getUsdcBalance, clearMetaMaskStorage } from '@/lib/walletUtils';

const SESSION_KEY = "active_session";

function generateAddress() {
  const chars = '0123456789abcdef';
  let addr = '0x';
  for (let i = 0; i < 40; i++) addr += chars[Math.floor(Math.random() * 16)];
  return addr;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [showBalance, setShowBalance] = useState(true);
  const [user, setUser] = useState(null);
  const [mmAddress, setMmAddress] = useState(() => localStorage.getItem("mm_address") || null);
  const [mmBalance, setMmBalance] = useState(null);
  const [mmConnecting, setMmConnecting] = useState(false);
  const [mmError, setMmError] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    base44.auth.me().then(setUser).catch(() => {});
  }, []);

  // 진행 중인 세션 복원
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY));
      if (saved?.sessionData && saved?.service) {
        setActiveSession(saved);
      }
    } catch {}
  }, []);

  // MetaMask 주소가 있을 때만 잔액 조회
  useEffect(() => {
    if (!mmAddress) return;
    getUsdcBalance(mmAddress).then(bal => {
      setMmBalance(bal);
      localStorage.setItem("mm_balance", bal);
    }).catch(() => {});
  }, [mmAddress]);

  // 10초마다 잔액 갱신 (MetaMask 연결 시에만)
  useEffect(() => {
    if (!mmAddress) return;
    const interval = setInterval(async () => {
      const bal = await getUsdcBalance(mmAddress);
      setMmBalance(bal);
      localStorage.setItem("mm_balance", bal);
    }, 10000);
    return () => clearInterval(interval);
  }, [mmAddress]);

  const { data: wallets = [], isLoading: walletsLoading } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });

  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => base44.entities.Transaction.list('-created_date', 20),
  });

  // Auto-create wallet for new users
  useEffect(() => {
    if (!walletsLoading && wallets.length === 0 && user) {
      base44.entities.Wallet.create({
        address: generateAddress(),
        balance: 0,
        network: 'Base Sepolia',
        is_active: true,
      }).then(() => queryClient.invalidateQueries({ queryKey: ['wallets'] }));
    }
  }, [walletsLoading, wallets, user, queryClient]);

  const wallet = wallets[0];

  const handleConnectMetaMask = async () => {
    setMmConnecting(true);
    setMmError(null);
    try {
      const addr = await connectMetaMask();
      const bal = await getUsdcBalance(addr);
      setMmAddress(addr);
      setMmBalance(bal);
      localStorage.setItem("mm_address", addr);
      localStorage.setItem("mm_balance", bal);
      if (wallet) {
        await base44.entities.Wallet.update(wallet.id, { address: addr, balance: bal });
        queryClient.invalidateQueries({ queryKey: ['wallets'] });
      }
    } catch (e) {
      setMmError(e.message);
    }
    setMmConnecting(false);
  };

  const handleDisconnectMetaMask = () => {
    setMmAddress(null);
    setMmBalance(null);
    setMmError(null);
    clearMetaMaskStorage();
    // DB wallet도 초기화
    if (wallet) {
      base44.entities.Wallet.update(wallet.id, { address: generateAddress(), balance: 0 })
        .then(() => queryClient.invalidateQueries({ queryKey: ['wallets'] }));
    }
  };

  const handleLogout = () => {
    clearMetaMaskStorage();
    base44.auth.logout('/');
  };

  // 경과 시간 포맷
  const fmtElapsed = () => {
    if (!activeSession?.startedAt) return '';
    const s = Math.floor((Date.now() - activeSession.startedAt) / 1000);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-center justify-between mb-6"
        >
          <div>
            <p className="text-xs text-muted-foreground">안녕하세요,</p>
            <h1 className="text-lg font-semibold">
              {user?.full_name || 'BasePay 사용자'}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-primary/10 border border-primary/20">
              <Zap className="w-3 h-3 text-primary" />
              <span className="text-[10px] font-semibold text-primary">Perun Channel</span>
            </div>
            <button
              onClick={handleLogout}
              className="p-2 rounded-xl hover:bg-secondary transition-colors"
              title="로그아웃"
            >
              <LogOut className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
        </motion.div>

        {/* 진행 중인 세션 배너 */}
        {activeSession && (
          <motion.button
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={() => navigate('/scan')}
            className="w-full mb-4 flex items-center justify-between p-4 rounded-2xl bg-destructive/10 border border-destructive/30 hover:bg-destructive/15 transition-colors text-left"
          >
            <div className="flex items-center gap-3">
              <div className="relative">
                <AlertTriangle className="w-5 h-5 text-destructive" />
                <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-destructive animate-ping" />
              </div>
              <div>
                <p className="text-sm font-semibold text-destructive">미종료 세션 있음</p>
                <p className="text-xs text-muted-foreground">
                  {activeSession.service?.emoji} {activeSession.service?.label} · {fmtElapsed()} 경과 · 탭하여 종료
                </p>
              </div>
            </div>
            <span className="text-xs text-destructive font-bold shrink-0">→</span>
          </motion.button>
        )}

        {/* MetaMask 연결 / 연결됨 */}
        <div className="mb-4">
          {!mmAddress ? (
            <button
              onClick={handleConnectMetaMask}
              disabled={mmConnecting}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-card border border-border hover:border-primary/30 hover:bg-primary/5 transition-all disabled:opacity-50"
            >
              <span className="text-lg">🦊</span>
              <span className="text-sm font-medium">
                {mmConnecting ? "연결 중..." : "MetaMask 연결"}
              </span>
            </button>
          ) : (
            <div className="flex items-center justify-between px-4 py-3 rounded-2xl bg-card border border-primary/20">
              <div className="flex items-center gap-2">
                <span className="text-lg">🦊</span>
                <div>
                  <p className="text-xs font-mono text-foreground">{mmAddress.slice(0, 8)}...{mmAddress.slice(-6)}</p>
                  <p className="text-[10px] text-primary">Base Sepolia</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="text-sm font-bold text-primary">
                    {mmBalance !== null ? mmBalance.toFixed(2) : '조회 중...'} USDC
                  </p>
                  <p className="text-[10px] text-muted-foreground">실제 잔액</p>
                </div>
                <button
                  onClick={handleDisconnectMetaMask}
                  className="text-[10px] text-muted-foreground hover:text-destructive transition-colors px-2 py-1 rounded-lg hover:bg-destructive/10"
                >
                  해제
                </button>
              </div>
            </div>
          )}
          {mmError && <p className="text-xs text-destructive mt-2 px-1">{mmError}</p>}
        </div>

        {/* Balance Card — MetaMask 연결 시에만 표시 */}
        {mmAddress ? (
          <div className="mb-6">
            <BalanceCard
              wallet={{ ...wallet, balance: mmBalance ?? 0, address: mmAddress }}
              showBalance={showBalance}
              onToggle={() => setShowBalance(!showBalance)}
            />
          </div>
        ) : (
          <div className="mb-6 rounded-3xl bg-card border border-border/50 border-dashed p-6 text-center">
            <p className="text-sm text-muted-foreground">MetaMask를 연결하면</p>
            <p className="text-sm text-muted-foreground">지갑 잔액과 주소를 확인할 수 있습니다</p>
          </div>
        )}

        {/* Quick Actions */}
        <div className="mb-6">
          <QuickActions />
        </div>

        {/* Smart City Info */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="rounded-2xl bg-gradient-to-r from-primary/5 via-card to-blue-500/5 border border-border p-4 mb-6"
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="text-base">🏙️</span>
            <span className="text-xs font-semibold">Smart City Payment</span>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Base 체인 기반 USDC 결제 시스템 · Perun State Channel을 활용한 실시간 마이크로페이먼트 · 주차, 대중교통, 공유 자전거, 전기차 충전
          </p>
        </motion.div>

        {/* Recent Transactions */}
        <RecentTransactions transactions={transactions} />
      </div>
      <BottomNav />
    </div>
  );
}