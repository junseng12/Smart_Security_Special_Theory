import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowLeft, ArrowUpRight, CheckCircle2, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import BottomNav from '@/components/wallet/BottomNav';

export default function Send() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];

  const handleSend = async () => {
    setError(null);
    const num = parseFloat(amount);
    if (!num || num <= 0) return setError('유효한 금액을 입력하세요');
    if (!address || address.length < 10) return setError('유효한 주소를 입력하세요');
    const mmBalance = parseFloat(localStorage.getItem("mm_balance") || wallet?.balance || 0);
    if (num > mmBalance) return setError('잔액이 부족합니다');

    setSending(true);
    await base44.entities.Transaction.create({
      type: 'send',
      amount: num,
      status: 'completed',
      to_address: address,
      from_address: wallet?.address || '',
      merchant_name: note || '송금',
      tx_hash: '0x' + Math.random().toString(16).slice(2, 18),
      wallet_id: wallet?.id,
      note,
    });
    if (wallet) {
      await base44.entities.Wallet.update(wallet.id, {
        balance: Math.max(0, (wallet.balance || 0) - num),
      });
    }
    queryClient.invalidateQueries({ queryKey: ['wallets'] });
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    setSending(false);
    setDone(true);
  };

  if (done) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200 }}
          className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
          <CheckCircle2 className="w-10 h-10 text-primary" />
        </motion.div>
        <h2 className="text-2xl font-bold mb-2">송금 완료!</h2>
        <p className="text-sm text-muted-foreground mb-2">{amount} USDC 전송됨</p>
        <p className="text-xs font-mono text-muted-foreground mb-6 truncate max-w-[250px]">→ {address}</p>
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
            <h1 className="text-lg font-semibold">송금</h1>
            <p className="text-xs text-muted-foreground">USDC를 다른 주소로 전송합니다</p>
          </div>
        </div>

        {/* Balance Info */}
        <div className="rounded-2xl bg-card border border-border p-4 mb-6 flex items-center justify-between">
          <div>
            <p className="text-xs text-muted-foreground">가용 잔액</p>
            <p className="text-xl font-bold">{(wallet?.balance || 0).toFixed(2)} <span className="text-sm text-muted-foreground">USDC</span></p>
          </div>
          <ArrowUpRight className="w-5 h-5 text-blue-400" />
        </div>

        {error && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2 p-3 rounded-xl bg-destructive/10 border border-destructive/20 text-destructive text-sm mb-4">
            <AlertCircle className="w-4 h-4 shrink-0" />{error}
          </motion.div>
        )}

        <div className="space-y-4 mb-6">
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block uppercase tracking-wider font-medium">받는 주소 *</label>
            <input value={address} onChange={e => setAddress(e.target.value)}
              placeholder="0x..."
              className="w-full bg-card border border-border rounded-xl p-3 text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block uppercase tracking-wider font-medium">금액 *</label>
            <div className="relative">
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full bg-card border border-border rounded-xl p-3 pr-16 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">USDC</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1.5 block uppercase tracking-wider font-medium">메모</label>
            <input value={note} onChange={e => setNote(e.target.value)}
              placeholder="선택 사항"
              className="w-full bg-card border border-border rounded-xl p-3 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition" />
          </div>
        </div>

        <Button onClick={handleSend} disabled={sending || !address || !amount}
          className="w-full h-12 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold disabled:opacity-40">
          {sending ? '전송 중...' : '송금하기'}
        </Button>
      </div>
      <BottomNav />
    </div>
  );
}