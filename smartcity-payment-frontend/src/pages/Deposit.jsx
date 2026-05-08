import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowLeft, Copy, Loader2, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { shortenAddress, formatUSDC, generateTxHash } from '@/lib/walletUtils';
import { toast } from 'sonner';

import BottomNav from '@/components/wallet/BottomNav';

export default function Deposit() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [deposited, setDeposited] = useState(false);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];

  const depositMutation = useMutation({
    mutationFn: async (depositAmount) => {
      await base44.entities.Transaction.create({
        type: 'deposit',
        amount: depositAmount,
        status: 'completed',
        to_address: wallet.address,
        from_address: 'External Wallet',
        merchant_name: 'USDC Deposit',
        tx_hash: generateTxHash(),
        wallet_id: wallet.id,
      });
      await base44.entities.Wallet.update(wallet.id, {
        balance: (wallet.balance || 0) + depositAmount,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      setDeposited(true);
    },
  });

  const quickAmounts = [10, 25, 50, 100];

  const handleDeposit = () => {
    const num = parseFloat(amount);
    if (!num || num <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    depositMutation.mutate(num);
  };

  const copyAddress = () => {
    if (wallet?.address) {
      navigator.clipboard.writeText(wallet.address);
      toast.success('Address copied');
    }
  };

  if (deposited) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6 pb-24">
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 200, damping: 15 }}
          className="w-20 h-20 rounded-full bg-accent/10 flex items-center justify-center mb-6"
        >
          <CheckCircle2 className="w-10 h-10 text-accent" />
        </motion.div>
        <h2 className="text-2xl font-bold mb-2">Deposit Successful!</h2>
        <p className="text-sm text-muted-foreground mb-8">
          ${formatUSDC(parseFloat(amount))} USDC added to your wallet
        </p>
        <Button onClick={() => navigate('/')} className="rounded-xl px-8 bg-primary hover:bg-primary/90">
          Back to Wallet
        </Button>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-8">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-semibold">Deposit USDC</h1>
        </div>

        {/* Wallet address */}
        <div className="rounded-2xl bg-secondary/50 border border-border p-4 mb-8">
          <p className="text-xs text-muted-foreground mb-2">Your Base Chain Address</p>
          <div className="flex items-center gap-2">
            <code className="text-sm font-mono text-foreground flex-1 break-all">
              {wallet?.address}
            </code>
            <button onClick={copyAddress} className="p-2 rounded-lg hover:bg-secondary transition-colors shrink-0">
              <Copy className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2">
            Send USDC on Base chain to this address
          </p>
        </div>

        {/* Quick deposit (demo) */}
        <div className="mb-6">
          <p className="text-xs text-muted-foreground mb-3 uppercase tracking-wider font-medium">
            Quick Deposit (Demo)
          </p>
          <div className="grid grid-cols-4 gap-2 mb-4">
            {quickAmounts.map((qa) => (
              <button
                key={qa}
                onClick={() => setAmount(String(qa))}
                className={`py-3 rounded-xl text-sm font-semibold transition-colors border ${
                  amount === String(qa)
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-secondary border-border hover:bg-secondary/80'
                }`}
              >
                ${qa}
              </button>
            ))}
          </div>
          <Input
            type="number"
            placeholder="Custom amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="h-14 rounded-xl text-lg font-semibold bg-secondary border-border text-center"
          />
        </div>

        <Button
          onClick={handleDeposit}
          disabled={!amount || depositMutation.isPending}
          className="w-full h-14 rounded-2xl text-base font-semibold bg-primary hover:bg-primary/90"
        >
          {depositMutation.isPending ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            `Deposit $${amount || '0.00'} USDC`
          )}
        </Button>
      </div>
      <BottomNav />
    </div>
  );
}