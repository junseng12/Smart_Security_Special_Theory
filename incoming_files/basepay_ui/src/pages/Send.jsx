import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { ArrowLeft, Loader2, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUSDC, generateTxHash } from '@/lib/walletUtils';
import { toast } from 'sonner';

import BottomNav from '@/components/wallet/BottomNav';

export default function Send() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [address, setAddress] = useState('');
  const [amount, setAmount] = useState('');
  const [sent, setSent] = useState(false);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];

  const sendMutation = useMutation({
    mutationFn: async ({ toAddress, sendAmount }) => {
      await base44.entities.Transaction.create({
        type: 'transfer',
        amount: sendAmount,
        status: 'completed',
        to_address: toAddress,
        from_address: wallet.address,
        merchant_name: `Transfer to ${toAddress.slice(0, 8)}...`,
        tx_hash: generateTxHash(),
        wallet_id: wallet.id,
      });
      await base44.entities.Wallet.update(wallet.id, {
        balance: (wallet.balance || 0) - sendAmount,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      setSent(true);
    },
  });

  const handleSend = () => {
    const num = parseFloat(amount);
    if (!address || !address.startsWith('0x') || address.length < 10) {
      toast.error('Enter a valid wallet address');
      return;
    }
    if (!num || num <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    if (num > (wallet?.balance || 0)) {
      toast.error('Insufficient balance');
      return;
    }
    sendMutation.mutate({ toAddress: address, sendAmount: num });
  };

  if (sent) {
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
        <h2 className="text-2xl font-bold mb-2">Transfer Sent!</h2>
        <p className="text-sm text-muted-foreground mb-8">
          ${formatUSDC(parseFloat(amount))} USDC sent successfully
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
        <div className="flex items-center gap-3 mb-8">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-semibold">Send USDC</h1>
        </div>

        <div className="space-y-4 mb-8">
          <div>
            <label className="text-xs text-muted-foreground mb-2 block uppercase tracking-wider font-medium">
              Recipient Address
            </label>
            <Input
              placeholder="0x..."
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="h-14 rounded-xl bg-secondary border-border font-mono text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-2 block uppercase tracking-wider font-medium">
              Amount (USDC)
            </label>
            <Input
              type="number"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="h-14 rounded-xl text-lg font-semibold bg-secondary border-border text-center"
            />
            <p className="text-xs text-muted-foreground mt-2 text-right">
              Balance: ${formatUSDC(wallet?.balance)}
            </p>
          </div>
        </div>

        <Button
          onClick={handleSend}
          disabled={!address || !amount || sendMutation.isPending}
          className="w-full h-14 rounded-2xl text-base font-semibold bg-primary hover:bg-primary/90"
        >
          {sendMutation.isPending ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            'Send USDC'
          )}
        </Button>
      </div>
      <BottomNav />
    </div>
  );
}