import React from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Home, QrCode, Clock, Shield, User } from 'lucide-react';

const NAV = [
  { path: '/', icon: Home, label: '홈' },
  { path: '/scan', icon: QrCode, label: '결제' },
  { path: '/history', icon: Clock, label: '내역' },
  { path: '/refund', icon: Shield, label: '환불' },
  { path: '/profile', icon: User, label: '계정' },
];

export default function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-card/80 backdrop-blur-xl border-t border-border z-40">
      <div className="max-w-md mx-auto flex items-center justify-around px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {NAV.map(({ path, icon: Icon, label }) => {
          const active = location.pathname === path;
          return (
            <button
              key={path}
              onClick={() => navigate(path)}
              className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-all ${
                active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className={`w-5 h-5 transition-transform ${active ? 'scale-110' : ''}`} />
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}