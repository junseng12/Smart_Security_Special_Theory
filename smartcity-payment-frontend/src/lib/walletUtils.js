export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
export const BASE_SEPOLIA_CHAIN_ID = "0x14a34"; // 84532

/**
 * MetaMask 실제 연결 상태 확인
 * localStorage가 아닌 window.ethereum 기준
 */
export async function getConnectedMetaMaskAddress() {
  if (!window.ethereum) return null;
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    return accounts && accounts.length > 0 ? accounts[0] : null;
  } catch {
    return null;
  }
}

export async function connectMetaMask() {
  if (!window.ethereum) throw new Error("MetaMask가 설치되지 않았습니다");
  try {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_SEPOLIA_CHAIN_ID }],
    });
  } catch (e) {
    if (e.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: BASE_SEPOLIA_CHAIN_ID,
          chainName: "Base Sepolia",
          rpcUrls: [BASE_SEPOLIA_RPC],
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          blockExplorerUrls: ["https://sepolia.basescan.org"],
        }],
      });
    } else {
      throw e;
    }
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  return accounts[0];
}

export async function getUsdcBalance(address) {
  const data = "0x70a08231" + address.replace("0x", "").padStart(64, "0");
  const res = await fetch(BASE_SEPOLIA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: USDC_ADDRESS, data }, "latest"],
    }),
  });
  const json = await res.json();
  const raw = BigInt(json.result && json.result !== "0x" ? json.result : "0x0");
  return Number(raw) / 1e6;
}

export async function sendUsdcOnChain(fromAddress, toAddress, amountUsdc) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");

  const amountMicro = BigInt(Math.round(amountUsdc * 1e6));
  const toHex = toAddress.replace("0x", "").toLowerCase().padStart(64, "0");
  const amountHex = amountMicro.toString(16).padStart(64, "0");
  const data = "0xa9059cbb" + toHex + amountHex;

  const txHash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{
      from: fromAddress,
      to: USDC_ADDRESS,
      data,
    }],
  });
  return txHash;
}

export function clearMetaMaskStorage() {
  localStorage.removeItem("mm_address");
  localStorage.removeItem("mm_balance");
  localStorage.removeItem("active_session");
}
