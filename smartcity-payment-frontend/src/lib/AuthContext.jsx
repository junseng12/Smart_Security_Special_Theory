import React, { createContext, useState, useContext, useEffect } from 'react';

const AuthContext = createContext();

export const AuthProvider = ({ children }) => {
  // Railway 독립 배포: Base44 Auth 제거, MetaMask 주소 기반 인증
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoadingAuth, setIsLoadingAuth] = useState(false);
  const [isLoadingPublicSettings, setIsLoadingPublicSettings] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [authChecked, setAuthChecked] = useState(true);
  const [appPublicSettings, setAppPublicSettings] = useState({ id: 'railway' });

  useEffect(() => {
    // MetaMask 주소가 localStorage에 있으면 자동 로그인 처리
    const addr = localStorage.getItem('mm_address');
    if (addr) {
      setUser({ address: addr, full_name: addr.slice(0, 6) + '...' + addr.slice(-4) });
      setIsAuthenticated(true);
    }
  }, []);

  const logout = () => {
    localStorage.removeItem('mm_address');
    localStorage.removeItem('mm_balance');
    setUser(null);
    setIsAuthenticated(false);
  };

  const navigateToLogin = () => {
    // MetaMask 연결로 대체 — Dashboard에서 처리
  };

  return (
    <AuthContext.Provider value={{
      user,
      isAuthenticated,
      isLoadingAuth,
      isLoadingPublicSettings,
      authError,
      appPublicSettings,
      authChecked,
      logout,
      navigateToLogin,
      checkUserAuth: () => {},
      checkAppState: () => {},
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
