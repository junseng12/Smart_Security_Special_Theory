import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Copy, ExternalLink, Shield, Wallet, Activity, LogOut } from 'lucide-react';
import BottomNav from '@/components/wallet/BottomNav';

export default function Profile() {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  // MetaMask localStorage에서 직접 읽기 (base44 엔티티 의존 제거)
  const mmAddress = localStorage.getItem('mm_address') || '';
  const mmBalance = localStorage.getItem('mm_balance') || '0';

  // 이용 세션 통계 (localStorage active_session 기반)
  const activeSess = (() => {
    try { return JSON.parse(localStorage.getItem('active_session') || 'null'); }
    catch { return null; }
  })();

  const copyAddress = () => {
    if (!mmAddress) return;
    navigator.clipboard.writeText(mmAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLogout = () => {
    localStorage.removeItem('mm_address');
    localStorage.removeItem('mm_balance');
    localStorage.removeItem('active_session');
    navigate('/');
    window.location.reload();
  };

  const shortAddr = mmAddress
    ? `${mmAddress.slice(0, 8)}...${mmAddress.slice(-6)}`
    : '연결되지 않음';

  return (
    <div className="min-h-screen bg-gray-50 pb-24">
      <div className="max-w-md mx-auto px-4 pt-6">

        {/* 헤더 */}
        <div className="flex items-center gap-3 mb-6">
          <button onClick={() => navigate('/')}
            className="p-2 rounded-xl hover:bg-gray-100 transition-colors">
            <ArrowLeft className="w-5 h-5 text-gray-600" />
          </button>
          <h1 className="text-lg font-semibold text-gray-900">계정 정보</h1>
        </div>

        {/* 프로필 카드 */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="bg-white rounded-2xl border border-gray-100 p-6 mb-4 shadow-sm">
          <div className="flex items-center gap-4 mb-4">
            <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center shadow">
              <span className="text-2xl font-bold text-white">
                {mmAddress ? mmAddress.slice(2, 3).toUpperCase() : 'W'}
              </span>
            </div>
            <div>
              <p className="text-base font-semibold text-gray-900">MetaMask 사용자</p>
              <p className="text-xs text-gray-400">Base Sepolia Network</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-100 w-fit">
            <Shield className="w-3 h-3 text-blue-500" />
            <span className="text-[10px] font-medium text-blue-600">
              {mmAddress ? '지갑 연결됨' : '지갑 미연결'}
            </span>
          </div>
        </motion.div>

        {/* 지갑 정보 */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}
          className="bg-white rounded-2xl border border-gray-100 p-6 mb-4 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Wallet className="w-4 h-4 text-blue-500" />
            <h3 className="text-sm font-semibold text-gray-900">지갑 정보</h3>
          </div>
          <div className="space-y-3 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-gray-500">네트워크</span>
              <span className="text-blue-600 font-medium">Base Sepolia</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">주소</span>
              <button onClick={copyAddress}
                className="flex items-center gap-1.5 text-xs font-mono text-gray-700 hover:text-blue-600 transition-colors">
                {shortAddr}
                <Copy className="w-3 h-3" />
                {copied && <span className="text-green-500 text-[10px]">복사됨!</span>}
              </button>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">잔액</span>
              <span className="font-semibold text-gray-900">
                {parseFloat(mmBalance || 0).toFixed(4)} USDC
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">상태</span>
              <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${mmAddress ? 'bg-green-400' : 'bg-gray-300'}`} />
                <span className={`text-xs ${mmAddress ? 'text-green-600' : 'text-gray-400'}`}>
                  {mmAddress ? '활성' : '미연결'}
                </span>
              </div>
            </div>
          </div>
        </motion.div>

        {/* 활동 통계 */}
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}
          className="bg-white rounded-2xl border border-gray-100 p-6 mb-4 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-4 h-4 text-blue-400" />
            <h3 className="text-sm font-semibold text-gray-900">현재 세션</h3>
          </div>
          {activeSess ? (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-gray-500">
                <span>세션 상태</span>
                <span className="text-green-600 font-medium">이용 중</span>
              </div>
              <div className="flex justify-between text-gray-500">
                <span>서비스 유형</span>
                <span className="text-gray-700">{activeSess.svc?.name || '-'}</span>
              </div>
              <div className="flex justify-between items-center text-gray-500">
                <span>세션 ID</span>
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(activeSess.sessionId || '');
                    alert('세션 ID 복사 완료!');
                  }}
                  className="flex items-center gap-1 font-mono text-xs text-gray-700 hover:text-blue-600 bg-gray-50 hover:bg-blue-50 border border-gray-200 rounded-lg px-2 py-0.5 transition-colors"
                >
                  {activeSess.sessionId?.slice(0, 14)}…
                  <span className="text-xs">📋</span>
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-400 text-center py-2">활성 세션 없음</p>
          )}
        </motion.div>

        {/* BaseScan 링크 */}
        {mmAddress && (
          <a href={`https://sepolia.basescan.org/address/${mmAddress}`}
            target="_blank" rel="noopener noreferrer"
            className="flex items-center justify-between p-4 rounded-2xl bg-white border border-gray-100 mb-4 hover:border-blue-200 shadow-sm transition-colors">
            <div className="flex items-center gap-3">
              <ExternalLink className="w-4 h-4 text-gray-400" />
              <span className="text-sm text-gray-700">BaseScan에서 보기</span>
            </div>
            <span className="text-xs text-blue-500">→</span>
          </a>
        )}

        {/* 로그아웃 */}
        <button onClick={handleLogout}
          className="w-full flex items-center justify-center gap-2 py-3.5 rounded-2xl border border-red-200 text-red-500 hover:bg-red-50 transition-colors text-sm font-medium">
          <LogOut className="w-4 h-4" />
          연결 해제
        </button>

      </div>
      <BottomNav />
    </div>
  );
}
