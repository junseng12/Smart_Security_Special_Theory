import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowLeft, Copy, QrCode, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import BottomNav from '@/components/wallet/BottomNav';
import { getUsdcBalance } from '@/lib/walletUtils';

export default function Deposit() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];
  const mmAddress = localStorage.getItem("mm_address");
  const displayAddress = mmAddress || wallet?.address;

  const copyAddress = () => {
    if (displayAddress) {
      navigator.clipboard.writeText(displayAddress);
      toast.success('주소가 복사되었습니다');
    }
  };

  // 실잔액 새로고침 (온체인 조회)
  const handleRefresh = async () => {
    if (!mmAddress) return toast.error('MetaMask를 먼저 연결해주세요');
    setRefreshing(true);
    try {
      const bal = await getUsdcBalance(mmAddress);
      localStorage.setItem("mm_balance", bal);
      if (wallet) await base44.entities.Wallet.update(wallet.id, { balance: bal });
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
      toast.success(`잔액 갱신: ${bal.toFixed(4)} USDC`);
    } catch (e) {
      toast.error('잔액 조회 실패: ' + e.message);
    }
    setRefreshing(false);
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">입금</h1>
            <p className="text-xs text-muted-foreground">아래 주소로 USDC를 입금하세요</p>
          </div>
        </div>

        {/* Address Card */}
        <div className="rounded-2xl bg-card border border-border p-6 mb-6 text-center">
          <div className="w-24 h-24 rounded-2xl bg-secondary/50 border border-border flex items-center justify-center mx-auto mb-4">
            <QrCode className="w-12 h-12 text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground mb-2">내 지갑 주소 (Base Sepolia)</p>
          {displayAddress ? (
            <button onClick={copyAddress}
              className="flex items-center gap-2 mx-auto px-4 py-2 rounded-xl bg-secondary/50 hover:bg-secondary/80 transition-colors">
              <span className="text-xs font-mono text-foreground truncate max-w-[200px]">{displayAddress}</span>
              <Copy className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            </button>
          ) : (
            <p className="text-xs text-muted-foreground">MetaMask를 연결하면 주소가 표시됩니다</p>
          )}
          <p className="text-[10px] text-primary mt-3">
            ⚠️ Base Sepolia 네트워크의 USDC만 입금 가능합니다
          </p>
        </div>

        {/* 잔액 새로고침 */}
        <div className="rounded-2xl bg-card border border-border p-4 mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">현재 USDC 잔액</p>
            <p className="text-xl font-bold">
              {parseFloat(localStorage.getItem("mm_balance") || wallet?.balance || 0).toFixed(4)}
              <span className="text-sm text-muted-foreground ml-1">USDC</span>
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing}
            className="rounded-xl gap-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? '조회중' : '새로고침'}
          </Button>
        </div>

        <div className="rounded-2xl bg-blue-500/5 border border-blue-500/20 p-4 text-sm text-blue-400 space-y-1">
          <p className="font-medium">입금 방법</p>
          <p className="text-xs text-muted-foreground">1. 위 주소를 복사합니다</p>
          <p className="text-xs text-muted-foreground">2. 외부 지갑 또는 거래소에서 Base Sepolia USDC를 전송합니다</p>
          <p className="text-xs text-muted-foreground">3. 입금 후 '새로고침' 버튼으로 잔액을 확인합니다</p>
          <p className="text-xs text-primary mt-1">테스트넷 USDC: <a href="https://faucet.circle.com" target="_blank" rel="noreferrer" className="underline">faucet.circle.com</a></p>
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
