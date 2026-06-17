// walletUtils.js — SmartCity Payment v3.2
// ★ 주소 하드코딩: 빌드 캐시 우회 용도로도 사용
export const USDC_ADDRESS        = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const ESCROW_V3_ADDRESS   = "0xa2642876a2Aa9F19D22a6e69379bbcA10556977f"; // SmartCityEscrow V3.2
export const OPERATOR_ADDRESS    = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";
export const SERVICE_PROVIDER_ADDRESS = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";

const RPC_LIST = [
  "https://base-sepolia-rpc.publicnode.com",
  "https://sepolia.base.org",
  "https://84532.rpc.thirdweb.com",
];
export const BASE_SEPOLIA_RPC      = RPC_LIST[0];
export const BASE_SEPOLIA_CHAIN_ID = "0x14a34"; // 84532

// ─────────────────────────────────────────────────────────
// MetaMask 연결
// ─────────────────────────────────────────────────────────
export async function getConnectedMetaMaskAddress() {
  if (!window.ethereum) return null;
  try {
    const accounts = await window.ethereum.request({ method: "eth_accounts" });
    return accounts && accounts.length > 0 ? accounts[0] : null;
  } catch { return null; }
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
          chainId: BASE_SEPOLIA_CHAIN_ID, chainName: "Base Sepolia",
          rpcUrls: [BASE_SEPOLIA_RPC],
          nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
          blockExplorerUrls: ["https://sepolia.basescan.org"],
        }],
      });
    } else { throw e; }
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  return accounts[0];
}

// ─────────────────────────────────────────────────────────
// USDC 잔액 조회
// ─────────────────────────────────────────────────────────
export async function getUsdcBalance(address) {
  const data = "0x70a08231" + address.replace("0x", "").padStart(64, "0");
  for (const rpc of RPC_LIST) {
    try {
      const res = await fetch(rpc, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: USDC_ADDRESS, data }, "latest"] }),
      });
      const j = await res.json();
      if (j.result && j.result !== "0x") return Number(BigInt(j.result)) / 1e6;
    } catch {}
  }
  return 0;
}

// ─────────────────────────────────────────────────────────
// USDC Transfer
// ─────────────────────────────────────────────────────────
export async function sendUsdcOnChain(fromAddress, toAddress, amountUsdc) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");
  const amountMicro = BigInt(Math.round(amountUsdc * 1e6));
  const toHex = toAddress.replace("0x", "").toLowerCase().padStart(64, "0");
  const amountHex = amountMicro.toString(16).padStart(64, "0");
  return await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: fromAddress, to: USDC_ADDRESS, data: "0xa9059cbb" + toHex + amountHex }],
  });
}

// ─────────────────────────────────────────────────────────
// RPC로 TX 컨펌 대기
// ─────────────────────────────────────────────────────────
async function waitForReceipt(txHash, intervalMs = 2000, maxMs = 90000) {
  const rpc = "https://sepolia.base.org";
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(rpc, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1,
          method: "eth_getTransactionReceipt", params: [txHash] }),
      });
      const { result } = await res.json();
      if (result) {
        if (result.status === "0x1") return result;
        throw new Error("TX reverted: " + txHash);
      }
    } catch (e) {
      if (e.message.startsWith("TX reverted")) throw e;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("TX 컨펌 타임아웃(90s): " + txHash);
}

// ─────────────────────────────────────────────────────────
// USDC allowance 조회
// ─────────────────────────────────────────────────────────
async function getAllowance(owner, spender) {
  const data = "0xdd62ed3e"
    + owner.replace("0x","").toLowerCase().padStart(64,"0")
    + spender.replace("0x","").toLowerCase().padStart(64,"0");
  for (const rpc of RPC_LIST) {
    try {
      const res = await fetch(rpc, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc:"2.0", id:1,
          method:"eth_call", params:[{ to: USDC_ADDRESS, data }, "latest"] }),
      });
      const { result } = await res.json();
      if (result && result !== "0x") return BigInt(result);
    } catch {}
  }
  return 0n;
}

// ─────────────────────────────────────────────────────────
// USDC Approve (컨펌 대기 포함)
// ─────────────────────────────────────────────────────────
export async function approveUsdcForEscrow(fromAddress, spender, amountUsdc) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");
  const needed = BigInt(Math.round(amountUsdc * 1e6));

  // 이미 충분한 allowance → approve 스킵
  const current = await getAllowance(fromAddress, spender);
  if (current >= needed) {
    console.log("[approve] 스킵 — 기존 allowance 충분:", current.toString());
    return null;
  }

  // MAX_UINT256으로 approve
  const MAX = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  const spenderHex = spender.replace("0x","").toLowerCase().padStart(64,"0");
  const txHash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: fromAddress, to: USDC_ADDRESS,
               data: "0x095ea7b3" + spenderHex + MAX, gas: "0x0186A0" }],
  });

  // ★ approve TX 체인 반영 확인 후 return
  await waitForReceipt(txHash);
  console.log("[approve] 컨펌 완료:", txHash);
  return txHash;
}

// ─────────────────────────────────────────────────────────
// escrowId → bytes32 변환
// ─────────────────────────────────────────────────────────
async function toBytes32Hex(str) {
  if (/^0x[0-9a-fA-F]{64}$/.test(str)) return str.replace("0x","");
  if (/^[0-9a-fA-F]{64}$/.test(str)) return str;
  const stripped = str.replace(/-/g,"");
  if (/^[0-9a-fA-F]+$/.test(stripped)) return stripped.padStart(64,"0").slice(0,64);
  const encoded = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuf)).map(b=>b.toString(16).padStart(2,"0")).join("");
}

// ─────────────────────────────────────────────────────────
// ★ userDeposit — 반드시 0xa2642876...10556977f 로 전송
// ─────────────────────────────────────────────────────────
export async function userDeposit(fromAddress, escrowId, operator, amountUsdc, holdDeadline) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");

  const TARGET = "0xa2642876a2Aa9F19D22a6e69379bbcA10556977f"; // 절대 변경 금지
  const escrowIdHex     = await toBytes32Hex(escrowId);
  const operatorHex     = operator.replace("0x","").toLowerCase().padStart(64,"0");
  const amountHex       = BigInt(Math.round(amountUsdc * 1e6)).toString(16).padStart(64,"0");
  const holdDeadlineHex = BigInt(holdDeadline).toString(16).padStart(64,"0");
  // userDeposit(bytes32,address,uint256,uint256) = 0x6ec5bc17
  const data = "0x6ec5bc17" + escrowIdHex + operatorHex + amountHex + holdDeadlineHex;

  console.log("[userDeposit] to:", TARGET);
  console.log("[userDeposit] selector: 0x6ec5bc17");
  console.log("[userDeposit] amount:", amountUsdc, "USDC");

  return await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: fromAddress, to: TARGET, data, gas: "0x49910" }],
  });
}

// ─────────────────────────────────────────────────────────
// localStorage 초기화
// ─────────────────────────────────────────────────────────
export function clearMetaMaskStorage() {
  localStorage.removeItem("mm_address");
  localStorage.removeItem("mm_balance");
  localStorage.removeItem("active_session");
}
