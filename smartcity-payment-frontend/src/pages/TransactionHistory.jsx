import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { base44 } from '@/api/base44Client';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowLeft, ArrowDownLeft, ArrowUpRight, QrCode, RefreshCw, Search } from 'lucide-react';
import { format } from 'date-fns';
import BottomNav from '@/components/wallet/BottomNav';

const TYPE_CONFIG = {
  deposit: { icon: ArrowDownLeft, label: '입금', color: 'text-primary', bg: 'bg-primary/10', sign: '+' },
  receive: { icon: ArrowDownLeft, label: '수신', color: 'text-primary', bg: 'bg-primary/10', sign: '+' },
  send: { icon: ArrowUpRight, label: '송금', color: 'text-blue-400', bg: 'bg-blue-500/10', sign: '-' },
  payment: { icon: QrCode, label: '결제', color: 'text-purple-400', bg: 'bg-purple-500/10', sign: '-' },
  session_start: { icon: QrCode, label: '세션', color: 'text-yellow-400', bg: 'bg-yellow-500/10', sign: '-' },
  refund: { icon: RefreshCw, label: '환불', color: 'text-orange-400', bg: 'bg-orange-500/10', sign: '+' },
};

const FILTERS = [
  { key: 'all', label: '전체' },
  { key: 'deposit', label: '입금' },
  { key: 'send', label: '송금' },
  { key: 'payment', label: '결제' },
  { key: 'refund', label: '환불' },
];

export default function TransactionHistory() {
  const navigate = useNavigate();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const { data: transactions = [], isLoading } = useQuery({
    queryKey: ['transactions-all'],
    queryFn: () => base44.entities.Transaction.list('-created_date', 100),
  });

  const filtered = transactions.filter(tx => {
    if (filter !== 'all' && tx.type !== filter) return false;
    if (search && !(tx.merchant_name || '').toLowerCase().includes(search.toLowerCase()) &&
        !(tx.tx_hash || '').toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="text-lg font-semibold">사용 내역</h1>
            <p className="text-xs text-muted-foreground">{transactions.length}건의 거래</p>
          </div>
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="거래 검색..."
            className="w-full bg-card border border-border rounded-xl pl-10 pr-4 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 transition" />
        </div>

        {/* Filters */}
        <div className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-hide">
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-all ${
                filter === f.key
                  ? 'bg-primary/10 text-primary border border-primary/20'
                  : 'bg-card border border-border text-muted-foreground hover:text-foreground'
              }`}>{f.label}</button>
          ))}
        </div>

        {/* Transactions */}
        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-sm text-muted-foreground">거래 내역이 없습니다</p>
          </div>
        ) : (
          <div className="space-y-2">
            <AnimatePresence>
              {filtered.map((tx, i) => {
                const config = TYPE_CONFIG[tx.type] || TYPE_CONFIG.payment;
                const TxIcon = config.icon;
                return (
                  <motion.div key={tx.id}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.02 }}
                    className="flex items-center gap-3 p-3 rounded-2xl bg-card border border-border">
                    <div className={`w-10 h-10 rounded-xl ${config.bg} flex items-center justify-center shrink-0`}>
                      <TxIcon className={`w-4 h-4 ${config.color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{tx.merchant_name || config.label}</p>
                      <div className="flex items-center gap-2">
                        <p className="text-[10px] text-muted-foreground">
                          {tx.created_date ? format(new Date(tx.created_date), 'yyyy.MM.dd HH:mm') : ''}
                        </p>
                        {tx.tx_hash && (
                          <p className="text-[10px] font-mono text-muted-foreground/50 truncate max-w-[100px]">
                            {tx.tx_hash}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className={`text-sm font-semibold ${config.sign === '+' ? 'text-primary' : 'text-foreground'}`}>
                        {config.sign}{tx.amount?.toFixed(2)}
                      </p>
                      <p className={`text-[10px] ${
                        tx.status === 'completed' ? 'text-primary' :
                        tx.status === 'active' ? 'text-yellow-400' :
                        tx.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                      }`}>
                        {tx.status === 'completed' ? '완료' :
                         tx.status === 'active' ? '진행중' :
                         tx.status === 'failed' ? '실패' : '대기중'}
                      </p>
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
      <BottomNav />
    </div>
  );
}