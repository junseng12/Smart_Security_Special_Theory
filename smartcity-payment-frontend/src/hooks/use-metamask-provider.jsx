import { useEffect, useMemo, useState } from 'react';
import {
  getMetaMaskDeepLink,
  getMetaMaskProvider,
  isMobileDevice,
} from '@/lib/walletUtils';

/** MetaMask Mobile의 지연 provider 주입까지 반영하는 공통 훅. */
export default function useMetaMaskProvider() {
  const [provider, setProvider] = useState(() => getMetaMaskProvider());
  const [isDetecting, setIsDetecting] = useState(() => !getMetaMaskProvider());

  useEffect(() => {
    let active = true;
    const detect = () => {
      if (!active) return;
      const detected = getMetaMaskProvider();
      if (detected) {
        setProvider(detected);
        setIsDetecting(false);
      }
    };

    detect();
    if (getMetaMaskProvider()) return () => { active = false; };

    window.addEventListener('ethereum#initialized', detect, { once: true });
    const timer = window.setTimeout(() => {
      if (!active) return;
      setProvider(getMetaMaskProvider());
      setIsDetecting(false);
    }, 3000);

    return () => {
      active = false;
      window.clearTimeout(timer);
      window.removeEventListener('ethereum#initialized', detect);
    };
  }, []);

  const isMobile = useMemo(() => isMobileDevice(), []);
  const deepLink = useMemo(() => getMetaMaskDeepLink(), []);

  return { provider, isDetecting, isMobile, deepLink };
}
