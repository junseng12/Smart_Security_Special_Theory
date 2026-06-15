export const USDC_ADDRESS   = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const ESCROW_V3      = "0x454Dd98f154cC4Af7ACB5390113151E2f0e489a1"; // SmartCityEscrow V3.2
export const OPERATOR_ADDR  = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";
export const BASE_SEPOLIA_RPC      = "https://sepolia.base.org";
export const BASE_SEPOLIA_CHAIN_ID = "0x14a34"; // 84532

// ── MetaMask 연결 & 네트워크 전환 ───────────────────────────────────────────
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
  return accounts[0];
}

// ── USDC 잔액 조회 ──────────────────────────────────────────────────────────
export async function getUsdcBalance(address) {
  const data = "0x70a08231" + address.replace("0x", "").padStart(64, "0");
  const rpcs = [BASE_SEPOLIA_RPC, "https://base-sepolia-rpc.publicnode.com"];
  for (const rpc of rpcs) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc:"2.0", id:1, method:"eth_call",
          params:[{ to: USDC_ADDRESS, data }, "latest"] }),
      });
      const json = await res.json();
      const raw = BigInt(json.result && json.result !== "0x" ? json.result : "0x0");
      return Number(raw) / 1e6;
    } catch { continue; }
  }
  return 0;
}

// ── RPC call 헬퍼 ───────────────────────────────────────────────────────────
async function rpcCall(method, params) {
  const res = await fetch(BASE_SEPOLIA_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params }),
  });
  return res.json();
}

// ── Step 1: USDC approve (에스크로 컨트랙트에 spender 허가) ─────────────────
// approve(address spender, uint256 amount)  selector: 0x095ea7b3
export async function approveUsdc(fromAddress, amountUsdc) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");
  const amountMicro = BigInt(Math.round(amountUsdc * 1e6));
  const spenderHex  = ESCROW_V3.replace("0x", "").toLowerCase().padStart(64, "0");
  const amountHex   = amountMicro.toString(16).padStart(64, "0");
  const data = "0x095ea7b3" + spenderHex + amountHex;

  const txHash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: fromAddress, to: USDC_ADDRESS, data }],
  });
  return txHash;
}

// ── Step 2: 컨트랙트 userDeposit 호출 ──────────────────────────────────────
// userDeposit(bytes32 escrowId, address operator, uint256 amount, uint256 holdDeadline)
// selector: keccak256("userDeposit(bytes32,address,uint256,uint256)") 앞 4바이트
export async function callUserDeposit(fromAddress, escrowId, amountUsdc, holdDeadline) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");

  // selector: 0x7ce5c8d3
  const selector   = "6ec5bc17";  // keccak256("userDeposit(bytes32,address,uint256,uint256)")
  const escrowHex  = escrowId.replace("0x", "").padStart(64, "0");
  const operHex    = OPERATOR_ADDR.replace("0x", "").toLowerCase().padStart(64, "0");
  const amountMicro = BigInt(Math.round(amountUsdc * 1e6));
  const amountHex  = amountMicro.toString(16).padStart(64, "0");
  const deadlineHex = BigInt(holdDeadline).toString(16).padStart(64, "0");
  const data = "0x" + selector + escrowHex + operHex + amountHex + deadlineHex;

  const txHash = await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: fromAddress, to: ESCROW_V3, data }],
  });
  return txHash;
}

// ── TX 확정 대기 (폴링) ─────────────────────────────────────────────────────
export async function waitForTx(txHash, maxWaitMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await rpcCall("eth_getTransactionReceipt", [txHash]);
    if (res.result && res.result.blockNumber) {
      if (res.result.status === "0x0") throw new Error("트랜잭션 실패 (revert)");
      return res.result;
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  throw new Error("트랜잭션 확정 시간 초과 (60s)");
}

// ── personal_sign (세션 정산 서명) ──────────────────────────────────────────
export async function personalSign(address, message) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");
  return window.ethereum.request({
    method: "personal_sign",
    params: [message, address],
  });
}

// ── localStorage 초기화 ─────────────────────────────────────────────────────
export function clearMetaMaskStorage() {
  localStorage.removeItem("mm_address");
  localStorage.removeItem("mm_balance");
  localStorage.removeItem("active_session");
}
