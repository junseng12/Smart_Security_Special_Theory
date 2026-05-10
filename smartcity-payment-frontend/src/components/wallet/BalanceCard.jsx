import React from 'react';
import { motion } from 'framer-motion';
import { Eye, EyeOff, Copy } from 'lucide-react';
import { toast } from 'sonner';

export default function BalanceCard({ wallet, showBalance, onToggle }) {
  const balance = wallet?.balance || 0;
  const address = wallet?.address || '0x...';

  const copyAddress = () => {
    navigator.clipboard.writeText(address);
    toast.success('주소가 복사되었습니다');
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary/20 via-card to-card border border-primary/10 p-6"
    >
      <div className="absolute top-0 right-0 w-40 h-40 bg-primary/5 rounded-full -translate-y-1/2 translate-x-1/2" />
      <div className="absolute bottom-0 left-0 w-24 h-24 bg-primary/5 rounded-full translate-y-1/2 -translate-x-1/2" />

      <div className="relative z-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center">
              <span className="text-primary text-sm font-bold">₿</span>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">BasePay Wallet</p>
              <p className="text-[10px] text-primary font-mono">Base Sepolia</p>
            </div>
          </div>
          <button onClick={onToggle} className="p-2 rounded-xl hover:bg-secondary/50 transition-colors">
            {showBalance ? <Eye className="w-4 h-4 text-muted-foreground" /> : <EyeOff className="w-4 h-4 text-muted-foreground" />}
          </button>
        </div>

        <div className="mb-4">
          <p className="text-xs text-muted-foreground mb-1">총 잔액</p>
          <div className="flex items-baseline gap-2">
            <span className="text-4xl font-bold tracking-tight">
              {showBalance ? balance.toFixed(2) : '••••••'}
            </span>
            <span className="text-sm text-muted-foreground font-medium">USDC</span>
          </div>
        </div>

        <button
          onClick={copyAddress}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-secondary/50 hover:bg-secondary/80 transition-colors"
        >
          <span className="text-xs font-mono text-muted-foreground truncate max-w-[180px]">{address}</span>
          <Copy className="w-3 h-3 text-muted-foreground shrink-0" />
        </button>
      </div>
    </motion.div>
  );
}