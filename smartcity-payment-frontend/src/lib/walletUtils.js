export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const ESCROW_V3_ADDRESS = "0xb6094337a6F37306eBDadd9923991275Cc6220f7"; // SmartCityEscrowV3 최신 배포 주소
export const OPERATOR_ADDRESS = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7"; // 컨트랙트 OPERATOR_ROLE
export const SERVICE_PROVIDER_ADDRESS = "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7"; // 요금 수취 = operator 동일
const RPC_LIST = [
  "https://base-sepolia-rpc.publicnode.com",
  "https://84532.rpc.thirdweb.com",
  "https://sepolia.base.org",
];
export const BASE_SEPOLIA_RPC = RPC_LIST[0]; // 체인 추가용 기본값
export const BASE_SEPOLIA_CHAIN_ID = "0x14a34"; // 84532

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
  for (const rpc of RPC_LIST) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "eth_call",
          params: [{ to: USDC_ADDRESS, data }, "latest"],
        }),
      });
      const json = await res.json();
      if (json.result && json.result !== "0x") {
        const raw = BigInt(json.result);
        return Number(raw) / 1e6;
      }
    } catch (e) {
      console.warn(`RPC 실패, 다음으로 전환: ${rpc}`, e.message);
    }
  }
  return 0;
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
 * USDC approve — 에스크로 컨트랙트에 지출 허가
 */
export async function approveUsdcForEscrow(fromAddress, spender, amountUsdc) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");
  const amountMicro = BigInt(Math.round(amountUsdc * 1e6));
  const spenderHex = spender.replace("0x", "").toLowerCase().padStart(64, "0");
  const amountHex = amountMicro.toString(16).padStart(64, "0");
  const data = "0x095ea7b3" + spenderHex + amountHex;
  return await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: fromAddress, to: USDC_ADDRESS, data }],
  });
}

/**
 * 임의 문자열(UUID 포함)을 32바이트 hex 문자열로 안전하게 변환
 * - 이미 0x+64자 hex → 그대로
 * - UUID(하이픈 제거 후 순수 hex) → padding
 * - 그 외 → Web Crypto SHA-256 해시
 */
async function toBytes32Hex(str) {
  // 이미 0x 포함 64자리 hex
  if (/^0x[0-9a-fA-F]{64}$/.test(str)) return str.replace("0x", "");
  // 0x 없는 64자리 hex
  if (/^[0-9a-fA-F]{64}$/.test(str)) return str;
  // UUID 형태 → 하이픈 제거 후 순수 hex
  const stripped = str.replace(/-/g, "");
  if (/^[0-9a-fA-F]+$/.test(stripped)) return stripped.padStart(64, "0").slice(0, 64);
  // 그 외 문자열 → SHA-256으로 안전 변환
  const encoded = new TextEncoder().encode(str);
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 에스크로 V3 userDeposit 호출
 */
export async function userDeposit(fromAddress, escrowId, operator, amountUsdc, holdDeadline) {
  if (!window.ethereum) throw new Error("MetaMask가 필요합니다");
  const selector        = "0x6ec5bc17"; // keccak256("userDeposit(bytes32,address,uint256,uint256)")
  const escrowIdHex     = await toBytes32Hex(escrowId);
  const operatorHex     = operator.replace("0x", "").toLowerCase().padStart(64, "0");
  const amountHex       = BigInt(Math.round(amountUsdc * 1e6)).toString(16).padStart(64, "0");
  const holdDeadlineHex = BigInt(holdDeadline).toString(16).padStart(64, "0");
  const data = selector + escrowIdHex + operatorHex + amountHex + holdDeadlineHex;
  return await window.ethereum.request({
    method: "eth_sendTransaction",
    params: [{ from: fromAddress, to: ESCROW_V3_ADDRESS, data }],
  });
}

/**
 * localStorage MetaMask 데이터 전체 초기화
 */
export function clearMetaMaskStorage() {
  localStorage.removeItem("mm_address");
  localStorage.removeItem("mm_balance");
  localStorage.removeItem("active_session");
}