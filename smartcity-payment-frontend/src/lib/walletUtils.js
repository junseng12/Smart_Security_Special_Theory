export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
export const BASE_SEPOLIA_CHAIN_ID = "0x14a34"; // 84532

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

/**
 * MetaMask로 USDC transfer 트랜잭션을 서명 & 브로드캐스트
 * @param {string} fromAddress - 보내는 주소 (MetaMask 연결 주소)
 * @param {string} toAddress   - 받는 주소
 * @param {number} amountUsdc  - USDC 금액 (소수점 포함)
 * @returns {string} txHash
 */
export async function sendUsdcOnChain(fromAddress, toAddress, amountUsdc) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");

  // ERC-20 transfer(address,uint256) selector: 0xa9059cbb
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
      // gas는 MetaMask가 자동 추정
    }],
  });
  return txHash;
}

/**
 * localStorage MetaMask 데이터 전체 초기화
 */
export function clearMetaMaskStorage() {
  localStorage.removeItem("mm_address");
  localStorage.removeItem("mm_balance");
  localStorage.removeItem("active_session");
}