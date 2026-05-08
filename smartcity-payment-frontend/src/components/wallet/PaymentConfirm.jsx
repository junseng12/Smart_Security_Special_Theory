import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Store, Shield, Loader2 } from 'lucide-react';
import { shortenAddress, formatUSDC } from '@/lib/walletUtils';

export default function PaymentConfirm({ payment, balance, onConfirm, onCancel }) {
  const [isProcessing, setIsProcessing] = useState(false);
  const insufficient = (balance || 0) < payment.amount;

  const handleConfirm = async () => {
    setIsProcessing(true);
    await onConfirm();
    setIsProcessing(false);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 50 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 50 }}
      className="fixed inset-0 z-50 bg-background flex flex-col"
    >
      <div className="flex items-center gap-3 p-4">
        <button onClick={onCancel} className="p-2 rounded-xl hover:bg-secondary transition-colors">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h2 className="text-lg font-semibold">Confirm Payment</h2>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center px-6">
        {/* Merchant info */}
        <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
          <Store className="w-7 h-7 text-primary" />
        </div>
        <h3 className="text-lg font-semibold mb-1">{payment.merchant}</h3>
        <p className="text-xs text-muted-foreground font-mono mb-8">
          {shortenAddress(payment.address)}
        </p>

        {/* Amount */}
        <div className="text-center mb-8">
          <p className="text-xs text-muted-foreground mb-1">Amount</p>
          <p className="text-5xl font-bold tracking-tight">${formatUSDC(payment.amount)}</p>
          <p className="text-sm text-muted-foreground mt-1">USDC on Base</p>
        </div>

        {/* Details card */}
        <div className="w-full rounded-2xl bg-secondary/50 border border-border p-4 space-y-3 mb-8">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Network</span>
            <span className="font-medium">Base Chain</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Token</span>
            <span className="font-medium">USDC</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Gas Fee</span>
            <span className="font-medium text-accent">~$0.001</span>
          </div>
          <div className="border-t border-border pt-3 flex justify-between text-sm">
            <span className="text-muted-foreground">Your Balance</span>
            <span className={`font-semibold ${insufficient ? 'text-destructive' : 'text-foreground'}`}>
              ${formatUSDC(balance)}
            </span>
          </div>
        </div>

        {insufficient && (
          <p className="text-sm text-destructive mb-4 flex items-center gap-1.5">
            <Shield className="w-4 h-4" />
            Insufficient balance
          </p>
        )}
      </div>

      <div className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <Button
          onClick={handleConfirm}
          disabled={insufficient || isProcessing}
          className="w-full h-14 rounded-2xl text-base font-semibold bg-primary hover:bg-primary/90 disabled:opacity-40"
        >
          {isProcessing ? (
            <Loader2 className="w-5 h-5 animate-spin" />
          ) : (
            `Pay $${formatUSDC(payment.amount)}`
          )}
        </Button>
      </div>
    </motion.div>
  );
}