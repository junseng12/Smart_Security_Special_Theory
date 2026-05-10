import React from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowDownLeft, ArrowUpRight, QrCode, RefreshCw } from 'lucide-react';

const ACTIONS = [
  { icon: ArrowDownLeft, label: '입금', path: '/deposit', color: 'bg-primary/10 text-primary' },
  { icon: ArrowUpRight, label: '송금', path: '/send', color: 'bg-blue-500/10 text-blue-400' },
  { icon: QrCode, label: 'QR 결제', path: '/scan', color: 'bg-purple-500/10 text-purple-400' },
  { icon: RefreshCw, label: '환불', path: '/refund', color: 'bg-orange-500/10 text-orange-400' },
];

export default function QuickActions() {
  const navigate = useNavigate();

  return (
    <div className="grid grid-cols-4 gap-3">
      {ACTIONS.map(({ icon: Icon, label, path, color }, i) => (
        <motion.button
          key={path}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.05 }}
          onClick={() => navigate(path)}
          className="flex flex-col items-center gap-2 py-3"
        >
          <div className={`w-12 h-12 rounded-2xl ${color} flex items-center justify-center`}>
            <Icon className="w-5 h-5" />
          </div>
          <span className="text-xs text-muted-foreground font-medium">{label}</span>
        </motion.button>
      ))}
    </div>
  );
}