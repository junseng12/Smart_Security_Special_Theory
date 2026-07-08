import React from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ScanLine, ArrowDownToLine, SendHorizontal, History } from 'lucide-react';

const actions = [
  { icon: ScanLine, label: 'Scan & Pay', path: '/scan', color: 'bg-primary/10 text-primary border-primary/20' },
  { icon: ArrowDownToLine, label: 'Deposit', path: '/deposit', color: 'bg-accent/10 text-accent border-accent/20' },
  { icon: SendHorizontal, label: 'Send', path: '/send', color: 'bg-chart-3/10 text-chart-3 border-chart-3/20' },
  { icon: History, label: 'History', path: '/history', color: 'bg-chart-4/10 text-chart-4 border-chart-4/20' },
];

export default function ActionButtons() {
  return (
    <div className="grid grid-cols-4 gap-3">
      {actions.map((action, i) => (
        <motion.div
          key={action.label}
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 + i * 0.05 }}
        >
          <Link
            to={action.path}
            className="flex flex-col items-center gap-2 group"
          >
            <div className={`w-14 h-14 rounded-2xl border flex items-center justify-center ${action.color} transition-transform group-hover:scale-105 group-active:scale-95`}>
              <action.icon className="w-5 h-5" />
            </div>
            <span className="text-[11px] font-medium text-muted-foreground group-hover:text-foreground transition-colors">
              {action.label}
            </span>
          </Link>
        </motion.div>
      ))}
    </div>
  );
}