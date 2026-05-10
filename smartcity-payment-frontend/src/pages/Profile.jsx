import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowLeft, Copy, ExternalLink, Shield, Wallet, Activity, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import BottomNav from '@/components/wallet/BottomNav';

export default function Profile() {
  const navigate = useNavigate();
  const [user, setUser] = useState(null);

  useEffect(() => {
    base44.auth.me().then(setUser).catch(() => {});
  }, []);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });

  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions-all'],
    queryFn: () => base44.entities.Transaction.list('-created_date', 100),
  });

  const wallet = wallets[0];

  const copyAddress = () => {
    if (wallet?.address) {
      navigator.clipboard.writeText(wallet.address);
      toast.success('주소가 복사되었습니다');
    }
  };

  const totalSpent = transactions
    .filter(t => ['send', 'payment'].includes(t.type) && t.status === 'completed')
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  const totalDeposited = transactions
    .filter(t => t.type === 'deposit' && t.status === 'completed')
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  const handleLogout = () => {
    localStorage.removeItem("mm_address");
    localStorage.removeItem("mm_balance");
    localStorage.removeItem("active_session");
    base44.auth.logout('/');
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-semibold">계정 정보</h1>
        </div>

        {/* Profile Card */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="rounded-2xl bg-card border border-border p-6 mb-4">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary/30 to-blue-500/30 flex items-center justify-center">
              <span className="text-2xl font-bold text-primary">
                {(user?.full_name || 'U')[0].toUpperCase()}
              </span>
            </div>
            <div>
              <p className="text-base font-semibold">{user?.full_name || '사용자'}</p>
              <p className="text-xs text-muted-foreground">{user?.email || ''}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/20 w-fit">
            <Shield className="w-3 h-3 text-primary" />
            <span className="text-[10px] font-medium text-primary">인증된 사용자</span>
          </div>
        </motion.div>

        {/* Wallet Info */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="rounded-2xl bg-card border border-border p-6 mb-4">
          <div className="flex items-center gap-2 mb-4">
            <Wallet className="w-4 h-4 text-primary" />
            <h3 className="text-sm font-semibold">지갑 정보</h3>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">네트워크</span>
              <span className="text-primary font-medium">{wallet?.network || 'Base Sepolia'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">주소</span>
              <button onClick={copyAddress} className="flex items-center gap-1.5 text-xs font-mono text-foreground hover:text-primary transition-colors">
                {wallet?.address ? `${wallet.address.slice(0, 8)}...${wallet.address.slice(-6)}` : '생성 중...'}
                <Copy className="w-3 h-3" />
              </button>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">잔액</span>
              <span className="font-semibold">{(wallet?.balance || 0).toFixed(2)} USDC</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-muted-foreground">상태</span>
              <div className="flex items-center gap-1.5">
                <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                <span className="text-xs text-primary">활성</span>
              </div>
            </div>
          </div>
        </motion.div>

        {/* Stats */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          className="rounded-2xl bg-card border border-border p-6 mb-4">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-4 h-4 text-blue-400" />
            <h3 className="text-sm font-semibold">활동 통계</h3>
          </div>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-lg font-bold">{transactions.length}</p>
              <p className="text-[10px] text-muted-foreground">총 거래</p>
            </div>
            <div>
              <p className="text-lg font-bold text-primary">{totalDeposited.toFixed(1)}</p>
              <p className="text-[10px] text-muted-foreground">총 입금</p>
            </div>
            <div>
              <p className="text-lg font-bold">{totalSpent.toFixed(1)}</p>
              <p className="text-[10px] text-muted-foreground">총 지출</p>
            </div>
          </div>
        </motion.div>

        {/* Explorer Link */}
        {wallet?.address && (
          <a href={`https://sepolia.basescan.org/address/${wallet.address}`}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-between p-4 rounded-2xl bg-card border border-border mb-4 hover:border-primary/30 transition-colors">
            <div className="flex items-center gap-3">
              <ExternalLink className="w-4 h-4 text-muted-foreground" />
              <span className="text-sm">BaseScan에서 보기</span>
            </div>
            <span className="text-xs text-primary">→</span>
          </a>
        )}

        {/* Logout */}
        <Button variant="outline" onClick={handleLogout}
          className="w-full rounded-xl border-destructive/30 text-destructive hover:bg-destructive/10">
          <LogOut className="w-4 h-4 mr-2" />
          로그아웃
        </Button>
      </div>
      <BottomNav />
    </div>
  );
}