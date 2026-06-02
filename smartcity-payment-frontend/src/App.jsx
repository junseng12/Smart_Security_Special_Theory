import { Toaster } from "@/components/ui/toaster"
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClientInstance } from '@/lib/query-client'
import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';
import PageNotFound from './lib/PageNotFound';
import { AuthProvider } from '@/lib/AuthContext';
import Dashboard from './pages/Dashboard';
import ScanPay from './pages/ScanPay';
import Deposit from './pages/Deposit';
import Send from './pages/Send';
import TransactionHistory from './pages/TransactionHistory';
import Profile from './pages/Profile';
import RefundCenter from './pages/RefundCenter';

function App() {
  return (
    <AuthProvider>
      <QueryClientProvider client={queryClientInstance}>
        <Router>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/scan" element={<ScanPay />} />
            <Route path="/deposit" element={<Deposit />} />
            <Route path="/send" element={<Send />} />
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
