import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowUpRight, CheckCircle2, ExternalLink,
  Loader2, RefreshCw, WalletCards
} from 'lucide-react';
import BottomNav from '@/components/wallet/BottomNav';
import {
  getConnectedMetaMaskAddress,
  getUsdcBalance,
  parseUsdcAmount,
  sendUsdcOnChain,
  waitForTransactionReceipt,
} from '@/lib/walletUtils';

const BASESCAN_TX = 'https://sepolia.basescan.org/tx/';

function shortAddress(address) {
  return address ? `${address.slice(0, 8)}...${address.slice(-6)}` : '';
}

function readableWalletError(error) {
  if (error?.code === 4001) return 'MetaMask에서 송금을 취소했습니다.';
  if (/insufficient funds/i.test(error?.message || '')) return '가스비로 사용할 Base Sepolia ETH가 부족합니다.';
  return error?.message || '송금 처리 중 오류가 발생했습니다.';
}

export default function Send() {
  const navigate = useNavigate();
  const storedAddress = localStorage.getItem('mm_address');
  const [address, setAddress] = useState(storedAddress);
  const [balance, setBalance] = useState(null);
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [stage, setStage] = useState('idle');
  const [error, setError] = useState(null);
  const [txHash, setTxHash] = useState(null);

  const refreshBalance = async (walletAddress = address) => {
    if (!walletAddress) return;
    const nextBalance = await getUsdcBalance(walletAddress);
    setBalance(nextBalance);
    localStorage.setItem('mm_balance', String(nextBalance));
  };

  useEffect(() => {
    let active = true;
    (async () => {
      const connected = await getConnectedMetaMaskAddress();
      if (!active) return;
      if (!connected || connected.toLowerCase() !== storedAddress?.toLowerCase()) {
        setAddress(null);
        setLoading(false);
        return;
      }
      setAddress(connected);
      try { await refreshBalance(connected); } catch {}
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fillMax = () => {
    if (balance != null) setAmount(Number(balance).toFixed(6).replace(/\.?0+$/, ''));
  };

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setTxHash(null);
    let submittedHash = null;

    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(recipient.trim())) throw new Error('받는 지갑 주소를 확인해주세요.');
      const amountMicro = parseUsdcAmount(amount);
      const balanceMicro = BigInt(Math.floor((balance || 0) * 1_000_000));
      if (amountMicro > balanceMicro) throw new Error('USDC 잔액이 부족합니다.');

      setSending(true);
      setStage('signing');
      submittedHash = await sendUsdcOnChain(address, recipient.trim(), amount);
      setTxHash(submittedHash);
      setStage('confirming');
      await waitForTransactionReceipt(submittedHash);
      setStage('success');
      await refreshBalance(address);
    } catch (e) {
      setError(readableWalletError(e));
      setStage(submittedHash ? 'submitted' : 'idle');
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return <div className="min-h-screen bg-background flex items-center justify-center"><Loader2 className="w-7 h-7 animate-spin text-primary" /></div>;
  }

  if (!address) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center px-6">
        <WalletCards className="w-12 h-12 text-muted-foreground mb-4" />
        <h1 className="text-lg font-semibold mb-2">MetaMask 연결 필요</h1>
        <p className="text-sm text-muted-foreground text-center mb-6">송금하려면 홈에서 MetaMask 지갑을 먼저 연결해주세요.</p>
        <button onClick={() => navigate('/')} className="px-6 py-3 rounded-xl bg-primary text-primary-foreground font-semibold">홈으로 돌아가기</button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')} className="p-2 rounded-xl hover:bg-secondary transition-colors"><ArrowLeft className="w-5 h-5" /></button>
          <div>
            <h1 className="text-lg font-semibold">USDC 송금</h1>
            <p className="text-xs text-muted-foreground">Base Sepolia 네트워크</p>
          </div>
        </div>

        <div className="rounded-2xl bg-card border border-border p-5 mb-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-xs text-muted-foreground mb-1">보내는 지갑</p>
              <p className="text-sm font-mono">{shortAddress(address)}</p>
            </div>
            <button onClick={() => refreshBalance()} className="p-2 rounded-xl hover:bg-secondary" aria-label="잔액 새로고침"><RefreshCw className="w-4 h-4 text-muted-foreground" /></button>
          </div>
          <p className="text-3xl font-bold mt-5">{balance == null ? '—' : balance.toFixed(6)} <span className="text-sm text-muted-foreground">USDC</span></p>
        </div>

        {stage === 'success' ? (
          <div className="rounded-2xl bg-card border border-border p-6 text-center">
            <CheckCircle2 className="w-14 h-14 text-emerald-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold">송금 완료</h2>
            <p className="text-sm text-muted-foreground mt-2">{amount} USDC를 전송했습니다.</p>
            <a href={`${BASESCAN_TX}${txHash}`} target="_blank" rel="noopener noreferrer" className="mt-5 flex items-center justify-center gap-1.5 text-sm text-primary">BaseScan에서 확인 <ExternalLink className="w-4 h-4" /></a>
            <button onClick={() => { setStage('idle'); setRecipient(''); setAmount(''); setTxHash(null); }} className="w-full mt-6 py-3 rounded-xl bg-primary text-primary-foreground font-semibold">새로 송금하기</button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <div className="rounded-2xl bg-card border border-border p-4">
              <label htmlFor="recipient" className="text-xs text-muted-foreground block mb-2">받는 지갑 주소</label>
              <input id="recipient" value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} placeholder="0x..." autoComplete="off" spellCheck="false" className="w-full bg-transparent outline-none font-mono text-sm" />
            </div>
            <div className="rounded-2xl bg-card border border-border p-4">
              <div className="flex items-center justify-between mb-2">
                <label htmlFor="amount" className="text-xs text-muted-foreground">송금 금액</label>
                <button type="button" onClick={fillMax} className="text-xs text-primary font-semibold">최대</button>
              </div>
              <div className="flex items-center gap-2">
                <input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" className="min-w-0 flex-1 bg-transparent outline-none text-2xl font-bold" />
                <span className="text-sm text-muted-foreground">USDC</span>
              </div>
            </div>

            {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400">{error}{txHash && <a href={`${BASESCAN_TX}${txHash}`} target="_blank" rel="noopener noreferrer" className="block underline mt-2">제출된 TX 확인</a>}</div>}

            {(stage === 'signing' || stage === 'confirming') && (
              <div className="rounded-xl bg-blue-500/10 border border-blue-500/20 p-3 text-sm text-blue-300 flex items-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                {stage === 'signing' ? 'MetaMask에서 송금을 확인해주세요.' : 'Base Sepolia에서 전송을 확인하고 있습니다.'}
              </div>
            )}

            <button type="submit" disabled={sending || balance == null} className="w-full h-12 rounded-xl bg-primary text-primary-foreground font-semibold disabled:opacity-50 flex items-center justify-center gap-2">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ArrowUpRight className="w-4 h-4" />}
              {sending ? '송금 처리 중' : 'MetaMask에서 송금하기'}
            </button>
            <p className="text-xs text-muted-foreground text-center">USDC 전송과 별도로 Base Sepolia ETH 가스비가 필요합니다.</p>
          </form>
        )}
      </div>
      <BottomNav />
    </div>
  );
}
