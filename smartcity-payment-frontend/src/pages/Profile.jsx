import React, { useState } from 'react';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import { Copy, ExternalLink, LogOut, Shield, Smartphone, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { shortenAddress } from '@/lib/walletUtils';
import { toast } from 'sonner';

import BottomNav from '@/components/wallet/BottomNav';

export default function Profile() {
  const [user, setUser] = useState(null);

  React.useEffect(() => {
    base44.auth.me().then(setUser).catch(() => {});
  }, []);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];

  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions-all'],
    queryFn: () => base44.entities.Transaction.list('-created_date', 50),
  });

  const copyAddress = () => {
    if (wallet?.address) {
      navigator.clipboard.writeText(wallet.address);
      toast.success('Address copied');
    }
  };

  const handleLogout = () => {
    base44.auth.logout('/');
  };

  const totalDeposited = transactions
    .filter(t => t.type === 'deposit')
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  const totalSpent = transactions
    .filter(t => t.type === 'payment' || t.type === 'transfer')
    .reduce((sum, t) => sum + (t.amount || 0), 0);

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <h1 className="text-lg font-semibold mb-6">Profile</h1>

        {/* Avatar & Name */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col items-center mb-8"
        >
          <div className="w-20 h-20 rounded-full bg-gradient-to-br from-primary to-accent flex items-center justify-center mb-3">
            <span className="text-2xl font-bold text-white">
              {user?.full_name?.[0]?.toUpperCase() || '?'}
            </span>
          </div>
          <h2 className="text-xl font-bold">{user?.full_name || 'User'}</h2>
          <p className="text-sm text-muted-foreground">{user?.email || ''}</p>
        </motion.div>

        {/* Wallet info */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="rounded-2xl bg-secondary/50 border border-border p-4 mb-4"
        >
          <div className="flex items-center gap-3 mb-3">
            <Wallet className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium">Wallet Address</span>
          </div>
          <button
            onClick={copyAddress}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-card border border-border hover:bg-secondary transition-colors"
          >
            <code className="text-xs font-mono text-muted-foreground flex-1 text-left truncate">
              {wallet?.address || '...'}
            </code>
            <Copy className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          </button>
        </motion.div>

        {/* Stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 }}
          className="grid grid-cols-2 gap-3 mb-4"
        >
          <div className="rounded-2xl bg-secondary/50 border border-border p-4">
            <p className="text-xs text-muted-foreground mb-1">Total Deposited</p>
            <p className="text-lg font-bold text-accent">${totalDeposited.toFixed(2)}</p>
          </div>
          <div className="rounded-2xl bg-secondary/50 border border-border p-4">
            <p className="text-xs text-muted-foreground mb-1">Total Spent</p>
            <p className="text-lg font-bold">${totalSpent.toFixed(2)}</p>
          </div>
        </motion.div>

        {/* Info cards */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="space-y-2 mb-8"
        >
          <div className="flex items-center gap-3 p-4 rounded-2xl bg-secondary/50 border border-border">
            <Shield className="w-4 h-4 text-primary" />
            <div className="flex-1">
              <p className="text-sm font-medium">Network</p>
              <p className="text-xs text-muted-foreground">Base Chain (L2)</p>
            </div>
          </div>
          <div className="flex items-center gap-3 p-4 rounded-2xl bg-secondary/50 border border-border">
            <Smartphone className="w-4 h-4 text-primary" />
            <div className="flex-1">
              <p className="text-sm font-medium">Token</p>
              <p className="text-xs text-muted-foreground">USDC (USD Coin)</p>
            </div>
          </div>
        </motion.div>

        {/* Logout */}
        <Button
          variant="outline"
          onClick={handleLogout}
          className="w-full rounded-xl h-12 border-destructive/20 text-destructive hover:bg-destructive/5 hover:text-destructive"
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sign Out
        </Button>
      </div>
      <BottomNav />
    </div>
  );
}