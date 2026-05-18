import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowLeft, Copy, QrCode, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import BottomNav from '@/components/wallet/BottomNav';

export default function Deposit() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [depositing, setDepositing] = useState(false);
  const [done, setDone] = useState(false);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];

  const copyAddress = () => {
    if (wallet?.address) {
      navigator.clipboard.writeText(wallet.address);
      toast.success('주소가 복사되었습니다');
    }
  };

  const handleDeposit = async () => {
    const num = parseFloat(amount);
    if (!num || num <= 0) return toast.error('유효한 금액을 입력하세요');
    setDepositing(true);
    await base44.entities.Transaction.create({
      type: 'deposit',
      amount: num,
      status: 'completed',
      to_address: wallet?.address || '',
      from_address: 'external',
      merchant_name: 'USDC 입금',
      tx_hash: '0x' + Math.random().toString(16).slice(2, 18),
      wallet_id: wallet?.id,
    });
    if (wallet) {
      await base44.entities.Wallet.update(wallet.id, {
        balance: (wallet.balance || 0) + num,
      });
    }
    queryClient.invalidateQueries({ queryKey: ['wallets'] });
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    setDepositing(false);
    setDone(true);
  };

  if (done) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200 }}
          className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
          <CheckCircle2 className="w-10 h-10 text-primary" />
        </motion.div>
        <h2 className="text-2xl font-bold mb-2">입금 완료!</h2>
        <p className="text-sm text-muted-foreground mb-6">{amount} USDC가 입금되었습니다</p>
        <Button onClick={() => navigate('/')} className="rounded-xl px-8">홈으로</Button>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-lg font-semibold">입금</h1>
            <p className="text-xs text-muted-foreground">USDC를 지갑에 입금합니다</p>
          </div>
        </div>

        {/* Address Card */}
        <div className="rounded-2xl bg-card border border-border p-6 mb-6 text-center">
          <div className="w-24 h-24 rounded-2xl bg-secondary/50 border border-border flex items-center justify-center mx-auto mb-4">
            <QrCode className="w-12 h-12 text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground mb-2">내 지갑 주소</p>
          <button
            onClick={copyAddress}
            className="flex items-center gap-2 mx-auto px-4 py-2 rounded-xl bg-secondary/50 hover:bg-secondary/80 transition-colors"
          >
            <span className="text-xs font-mono text-foreground truncate max-w-[200px]">
              {wallet?.address || '지갑 생성 중...'}
            </span>
            <Copy className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          </button>
          <p className="text-[10px] text-primary mt-2">Base Sepolia 네트워크</p>
        </div>

        {/* Quick Amounts */}
        <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wider font-medium">빠른 금액 선택</p>
        <div className="grid grid-cols-4 gap-2 mb-4">
          {[5, 10, 25, 50].map(v => (
            <button key={v} onClick={() => setAmount(String(v))}
              className={`py-2.5 rounded-xl border text-sm font-medium transition-all ${
                amount === String(v)
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border bg-card text-muted-foreground hover:border-primary/30'
              }`}>{v} USDC</button>
          ))}
        </div>

        {/* Custom Amount */}
        <div className="relative mb-6">
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="금액 입력"
            className="w-full bg-card border border-border rounded-xl p-4 pr-16 text-lg font-semibold text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition"
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">USDC</span>
        </div>

        <Button onClick={handleDeposit} disabled={depositing || !amount}
          className="w-full h-12 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold disabled:opacity-40">
          {depositing ? '처리 중...' : '입금하기'}
        </Button>
      </div>
      <BottomNav />
    </div>
  );
}