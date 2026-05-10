import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowDownLeft, ArrowUpRight, QrCode, RefreshCw, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';

const TYPE_CONFIG = {
  deposit: { icon: ArrowDownLeft, label: '입금', color: 'text-primary', bg: 'bg-primary/10', sign: '+' },
  receive: { icon: ArrowDownLeft, label: '수신', color: 'text-primary', bg: 'bg-primary/10', sign: '+' },
  send: { icon: ArrowUpRight, label: '송금', color: 'text-blue-400', bg: 'bg-blue-500/10', sign: '-' },
  payment: { icon: QrCode, label: '결제', color: 'text-purple-400', bg: 'bg-purple-500/10', sign: '-' },
  session_start: { icon: QrCode, label: '세션 시작', color: 'text-yellow-400', bg: 'bg-yellow-500/10', sign: '-' },
  refund: { icon: RefreshCw, label: '환불', color: 'text-orange-400', bg: 'bg-orange-500/10', sign: '+' }
};

export default function RecentTransactions({ transactions = [] }) {
  const navigate = useNavigate();
  const recent = transactions.slice(0, 5);

  if (recent.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-muted-foreground">아직 거래 내역이 없습니다</p>
      </div>);

  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">최근 거래</h3>
        <button
          onClick={() => navigate('/history')}
          className="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors">
          
          전체보기 <ChevronRight className="w-3 h-3" />
        </button>
      </div>

      <div className="space-y-2">
        {recent.map((tx, i) => {
          const config = TYPE_CONFIG[tx.type] || TYPE_CONFIG.payment;
          const TxIcon = config.icon;
          return null;
































        })}
      </div>
    </div>);

}