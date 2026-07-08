import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'framer-motion';
import { generateTxHash } from '@/lib/walletUtils';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

import QRScanner from '@/components/wallet/QRScanner';
import PaymentConfirm from '@/components/wallet/PaymentConfirm';
import BottomNav from '@/components/wallet/BottomNav';

export default function ScanPay() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [scannedPayment, setScannedPayment] = useState(null);
  const [paymentSuccess, setPaymentSuccess] = useState(false);

  const { data: wallets = [] } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => base44.entities.Wallet.list(),
  });
  const wallet = wallets[0];

  const payMutation = useMutation({
    mutationFn: async (payment) => {
      // Create transaction record
      await base44.entities.Transaction.create({
        type: 'payment',
        amount: payment.amount,
        status: 'completed',
        to_address: payment.address,
        from_address: wallet.address,
        merchant_name: payment.merchant,
        tx_hash: generateTxHash(),
        wallet_id: wallet.id,
      });
      // Update wallet balance
      await base44.entities.Wallet.update(wallet.id, {
        balance: (wallet.balance || 0) - payment.amount,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      setPaymentSuccess(true);
    },
  });

  const handleScan = (paymentData) => {
    setScannedPayment(paymentData);
  };

  const handleConfirm = async () => {
    await payMutation.mutateAsync(scannedPayment);
  };

  if (paymentSuccess) {
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
        <motion.h2
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="text-2xl font-bold mb-2"
        >
          Payment Sent!
        </motion.h2>
        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3 }}
          className="text-sm text-muted-foreground mb-8 text-center"
        >
          ${scannedPayment?.amount?.toFixed(2)} USDC sent to {scannedPayment?.merchant}
        </motion.p>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
        >
          <Button
            onClick={() => navigate('/')}
            className="rounded-xl px-8 bg-primary hover:bg-primary/90"
          >
            Back to Wallet
          </Button>
        </motion.div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <AnimatePresence mode="wait">
        {scannedPayment ? (
          <PaymentConfirm
            key="confirm"
            payment={scannedPayment}
            balance={wallet?.balance}
            onConfirm={handleConfirm}
            onCancel={() => setScannedPayment(null)}
          />
        ) : (
          <QRScanner
            key="scanner"
            onScan={handleScan}
            onClose={() => navigate('/')}
          />
        )}
      </AnimatePresence>
      {!scannedPayment && <BottomNav />}
    </div>
  );
}