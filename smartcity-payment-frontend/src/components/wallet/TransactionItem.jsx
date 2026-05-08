import React from 'react';
import { ArrowDownToLine, ArrowUpRight, ScanLine } from 'lucide-react';
import { formatUSDC, shortenAddress } from '@/lib/walletUtils';
import { format } from 'date-fns';

const typeConfig = {
  deposit: { icon: ArrowDownToLine, label: 'Deposit', color: 'text-accent bg-accent/10' },
  payment: { icon: ScanLine, label: 'Payment', color: 'text-destructive bg-destructive/10' },
  transfer: { icon: ArrowUpRight, label: 'Transfer', color: 'text-chart-3 bg-chart-3/10' },
};

export default function TransactionItem({ transaction }) {
  const config = typeConfig[transaction.type] || typeConfig.deposit;
  const Icon = config.icon;
  const isIncoming = transaction.type === 'deposit';

  return (
    <div className="flex items-center gap-3 py-3 px-1">
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${config.color}`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">
          {transaction.merchant_name || config.label}
        </p>
        <p className="text-xs text-muted-foreground">
          {transaction.created_date ? format(new Date(transaction.created_date), 'MMM d, h:mm a') : ''}
        </p>
      </div>
      <div className="text-right">
        <p className={`text-sm font-semibold ${isIncoming ? 'text-accent' : 'text-foreground'}`}>
          {isIncoming ? '+' : '-'}${formatUSDC(transaction.amount)}
        </p>
        <p className="text-[10px] text-muted-foreground capitalize">{transaction.status}</p>
      </div>
    </div>
  );
}