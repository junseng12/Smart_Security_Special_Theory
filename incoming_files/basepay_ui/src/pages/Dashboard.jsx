import React, { useState, useEffect } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { generateWalletAddress, generatePrivateKeyHash } from '@/lib/walletUtils';
import { Loader2 } from 'lucide-react';

import BalanceCard from '@/components/wallet/BalanceCard';
import ActionButtons from '@/components/wallet/ActionButtons';
import TransactionItem from '@/components/wallet/TransactionItem';
import BottomNav from '@/components/wallet/BottomNav';

export default function Dashboard() {
  const [showBalance, setShowBalance] = useState(true);
  const queryClient = useQueryClient();

  // Fetch or create wallet
  const { data: wallets, isLoading: walletsLoading } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });

  const createWalletMutation = useMutation({
    mutationFn: (data) => base44.entities.Wallet.create(data),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['wallets'] }),
  });

  const wallet = wallets?.[0];

  // Auto-create wallet for new users
  useEffect(() => {
    if (!walletsLoading && wallets && wallets.length === 0) {
      createWalletMutation.mutate({
        address: generateWalletAddress(),
        balance: 0,
        private_key_hash: generatePrivateKeyHash(),
      });
    }
  }, [walletsLoading, wallets]);

  // Fetch recent transactions
  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions'],
    queryFn: () => base44.entities.Transaction.list('-created_date', 10),
    enabled: !!wallet,
  });

  if (walletsLoading || createWalletMutation.isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">Setting up your wallet...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="flex items-center justify-between mb-6"
        >
          <div>
            <p className="text-xs text-muted-foreground">Welcome back</p>
            <h2 className="text-lg font-semibold">My Wallet</h2>
          </div>
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center">
            <span className="text-xs font-bold text-white">
              {wallet?.address?.slice(2, 4)?.toUpperCase() || 'W'}
            </span>
          </div>
        </motion.div>

        {/* Balance */}
        <div className="mb-6">
          <BalanceCard
            wallet={wallet}
            showBalance={showBalance}
            onToggleBalance={() => setShowBalance(!showBalance)}
          />
        </div>

        {/* Action buttons */}
        <div className="mb-8">
          <ActionButtons />
        </div>

        {/* Recent transactions */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
        >
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
              Recent Activity
            </h3>
          </div>

          {transactions.length === 0 ? (
            <div className="text-center py-12 rounded-2xl bg-secondary/30 border border-border">
              <p className="text-sm text-muted-foreground">No transactions yet</p>
              <p className="text-xs text-muted-foreground mt-1">Deposit USDC to get started</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {transactions.map((tx) => (
                <TransactionItem key={tx.id} transaction={tx} />
              ))}
            </div>
          )}
        </motion.div>
      </div>

      <BottomNav />
    </div>
  );
}