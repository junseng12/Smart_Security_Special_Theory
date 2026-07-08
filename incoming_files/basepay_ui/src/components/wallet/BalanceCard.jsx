import React from 'react';
import { motion } from 'framer-motion';
import { Copy, Eye, EyeOff } from 'lucide-react';
import { shortenAddress, formatUSDC } from '@/lib/walletUtils';
import { toast } from 'sonner';

export default function BalanceCard({ wallet, showBalance, onToggleBalance }) {
  const copyAddress = () => {
    if (wallet?.address) {
      navigator.clipboard.writeText(wallet.address);
      toast.success('Address copied to clipboard');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-primary/20 via-card to-card border border-primary/10 p-6"
    >
      {/* Decorative elements */}
      <div className="absolute top-0 right-0 w-40 h-40 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/2" />
      <div className="absolute bottom-0 left-0 w-24 h-24 bg-accent/5 rounded-full translate-y-1/2 -translate-x-1/2" />

      <div className="relative z-10">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            USDC Balance
          </span>
          <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/10 border border-accent/20">
            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
            <span className="text-[10px] font-medium text-accent">Base Chain</span>
          </div>
        </div>

        <div className="flex items-center gap-3 mb-5">
          <h1 className="text-4xl font-bold tracking-tight">
            {showBalance ? (
              <span>${formatUSDC(wallet?.balance)}</span>
            ) : (
              <span>••••••</span>
            )}
          </h1>
          <button onClick={onToggleBalance} className="p-1.5 rounded-lg hover:bg-secondary transition-colors">
            {showBalance ? (
              <EyeOff className="w-4 h-4 text-muted-foreground" />
            ) : (
              <Eye className="w-4 h-4 text-muted-foreground" />
            )}
          </button>
        </div>

        <button
          onClick={copyAddress}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/60 hover:bg-secondary transition-colors group"
        >
          <span className="text-xs font-mono text-muted-foreground group-hover:text-foreground transition-colors">
            {shortenAddress(wallet?.address, 8)}
          </span>
          <Copy className="w-3 h-3 text-muted-foreground group-hover:text-foreground transition-colors" />
        </button>
      </div>
    </motion.div>
  );
}