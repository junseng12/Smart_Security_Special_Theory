import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider } from '@/lib/AuthContext';
import React from 'react';
import Dashboard from './pages/Dashboard';
import ScanPay from './pages/ScanPay';
import Deposit from './pages/Deposit';
import TransactionHistory from './pages/TransactionHistory';
import Profile from './pages/Profile';
import RefundCenter from './pages/RefundCenter';

// ScanPay 렌더 에러 시 검은 화면 방지 — localStorage 클리어 후 홈으로
class ScanPayBoundary extends React.Component {
  constructor(props) { super(props); this.state = { crashed: false }; }
  static getDerivedStateFromError() { return { crashed: true }; }
  componentDidCatch() {
    try {
      localStorage.removeItem("active_session");
      localStorage.removeItem("payment_processing");
    } catch {}
  }
  render() {
    if (this.state.crashed) {
      return (
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center',
                      justifyContent:'center', height:'100vh', background:'#fff',
                      fontFamily:'sans-serif', gap:16 }}>
          <div style={{ fontSize:40 }}>⚠️</div>
          <div style={{ fontSize:16, color:'#333' }}>결제 화면 오류가 발생했습니다</div>
          <button onClick={() => { this.setState({ crashed: false }); window.location.href = '/scan'; }}
            style={{ padding:'12px 28px', background:'#2563eb', color:'#fff',
                     border:'none', borderRadius:10, fontSize:15, cursor:'pointer' }}>
            다시 시도
          </button>
          <button onClick={() => { window.location.href = '/'; }}
            style={{ padding:'8px 20px', background:'#f3f4f6', color:'#555',
                     border:'none', borderRadius:10, fontSize:14, cursor:'pointer' }}>
            홈으로
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/scan" element={<ScanPayBoundary><ScanPay /></ScanPayBoundary>} />
            <Route path="/deposit" element={<Deposit />} />
            <Route path="/history" element={<TransactionHistory />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/refund" element={<RefundCenter />} />
            <Route path="*" element={<PageNotFound />} />
          </Routes>
        </Router>
        <Toaster />
      </QueryClientProvider>
    </AuthProvider>
  );
}

export default App;
