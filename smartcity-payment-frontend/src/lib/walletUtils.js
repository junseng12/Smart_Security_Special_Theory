// ── 상수 ──────────────────────────────────────────────────────────────────────
export const USDC_ADDRESS      = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const ESCROW_V3_ADDRESS = "0xb6094337a6F37306eBDadd9923991275Cc6220f7";
export const OPERATOR_ADDRESS  = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";
export const BASE_SEPOLIA_RPC  = "https://sepolia.base.org";
export const BASE_SEPOLIA_CHAIN_ID = "0x14a34"; // 84532

// ── RPC 폴백 리스트 ────────────────────────────────────────────────────────────
const RPC_LIST = [
  "https://sepolia.base.org",
  "https://base-sepolia-rpc.publicnode.com",
  "https://84532.rpc.thirdweb.com",
];

async function rpcCall(method, params) {
  for (const rpc of RPC_LIST) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const json = await res.json();
      if (json.result !== undefined) return json.result;
    } catch {}
  }
  throw new Error("모든 RPC 응답 실패");
}

// ── MetaMask 연결 ──────────────────────────────────────────────────────────────
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
    } else { throw e; }
  }
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const addr = accounts[0];
  // operator 계정 차단
  if (addr.toLowerCase() === OPERATOR_ADDRESS.toLowerCase()) {
    throw new Error("운영자 계정으로는 결제할 수 없습니다. 사용자 계정을 선택하세요.");
  }
  return addr;
}

// ── USDC 잔액 조회 ─────────────────────────────────────────────────────────────
export async function getUsdcBalance(address) {
  try {
    const data = "0x70a08231" + address.replace("0x", "").padStart(64, "0");
    const result = await rpcCall("eth_call", [{ to: USDC_ADDRESS, data }, "latest"]);
    const raw = BigInt(result && result !== "0x" ? result : "0x0");
    return Number(raw) / 1e6;
  } catch { return 0; }
}

// ── USDC approve (에스크로 컨트랙트에 지출 허용) ───────────────────────────────
export async function approveUsdcForEscrow(fromAddress, spender, amountUsdc) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");
  const amountMicro = BigInt(Math.round(amountUsdc * 1e6));
  const spenderHex  = spender.replace("0x", "").toLowerCase().padStart(64, "0");
  const amountHex   = amountMicro.toString(16).padStart(64, "0");
  const data = "0x095ea7b3" + spenderHex + amountHex; // approve(address,uint256)
  return await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: fromAddress, to: USDC_ADDRESS, data }],
  });
}

// ── bytes32 변환 헬퍼 (keccak256 hex 그대로 통과) ─────────────────────────────
async function toBytes32Hex(str) {
  if (/^0x[0-9a-fA-F]{64}$/.test(str)) return str.replace("0x", "");
  if (/^[0-9a-fA-F]{64}$/.test(str))   return str;
  const stripped = str.replace(/-/g, "");
  if (/^[0-9a-fA-F]+$/.test(stripped))  return stripped.padStart(64, "0").slice(0, 64);
  const encoded  = new TextEncoder().encode(str);
  const hashBuf  = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

// ── SmartCityEscrowV3 userDeposit 온체인 호출 ─────────────────────────────────
// 순서: approve → userDeposit (approve TX 확정 대기 후 호출)
export async function approveAndUserDeposit(fromAddress, escrowId, operator, amountUsdc, holdDeadline) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");

  // 1) USDC approve
  const approveTxHash = await approveUsdcForEscrow(fromAddress, ESCROW_V3_ADDRESS, amountUsdc);
  // approve TX 확정 대기 (최대 60초)
  await waitForTx(approveTxHash, 60000);

  // 2) userDeposit
  const selector      = "0x6ec5bc17"; // keccak256("userDeposit(bytes32,address,uint256,uint256)")
  const escrowIdHex   = await toBytes32Hex(escrowId);
  const operatorHex   = operator.replace("0x", "").toLowerCase().padStart(64, "0");
  const amountHex     = BigInt(Math.round(amountUsdc * 1e6)).toString(16).padStart(64, "0");
  const deadlineHex   = BigInt(holdDeadline).toString(16).padStart(64, "0");
  const calldata      = selector + escrowIdHex + operatorHex + amountHex + deadlineHex;

  return await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: fromAddress, to: ESCROW_V3_ADDRESS, data: calldata }],
  });
}

// ── TX 확정 대기 ───────────────────────────────────────────────────────────────
export async function waitForTx(txHash, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await rpcCall("eth_getTransactionReceipt", [txHash]);
      if (receipt?.status) {
        if (receipt.status === "0x0") throw new Error("트랜잭션이 실패(revert)했습니다");
        return receipt;
      }
    } catch (e) {
      if (e.message.includes("revert")) throw e;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("트랜잭션 확정 시간 초과 (90초)");
}

// ── MetaMask personal_sign ─────────────────────────────────────────────────────
export async function personalSign(address, message) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");
  return await window.ethereum.request({
    method: "personal_sign",
    params: [message, address],
  });
}

// ── localStorage 초기화 ────────────────────────────────────────────────────────
export function clearMetaMaskStorage() {
  localStorage.removeItem("mm_address");
  localStorage.removeItem("mm_balance");
  localStorage.removeItem("active_session");
}
