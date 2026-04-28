/**
 * User Wallet Service
 * ─────────────────────────────────────────────────────────────────────────────
 * - Verifies ECDSA signatures from users
 * - Checks USDC balances on Base L2
 * - Provides operator signing capability
 * - Base chain RPC helpers
 */

const { ethers } = require('ethers');
const logger = require('../utils/logger');

// ERC-20 minimal ABI (balanceOf + transfer)
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

let provider;
let operatorWallet;
let treasuryWallet;
let usdcContract;

/**
 * Initialise provider and wallets. Called lazily on first use.
 */
function init() {
  if (provider) return;

  provider = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
  operatorWallet = new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);
  treasuryWallet = new ethers.Wallet(process.env.TREASURY_PRIVATE_KEY, provider);

  usdcContract = new ethers.Contract(
    process.env.USDC_CONTRACT_ADDRESS,
    ERC20_ABI,
    provider
  );

  logger.info('WalletService initialised', {
    operatorAddress: operatorWallet.address,
    treasuryAddress: treasuryWallet.address,
  });
}

// ── Signature verification ────────────────────────────────────────────────────

/**
 * Build the canonical state message that both sides sign.
 * Format: keccak256(abi.encodePacked(channelId, nonce, balanceUser, balanceOperator))
 */
function buildStateMessage(channelId, nonce, balanceUser, balanceOperator) {
  return ethers.solidityPackedKeccak256(
    ['bytes32', 'uint256', 'uint256', 'uint256'],
    [
      ethers.zeroPadValue(ethers.toBeHex(channelId), 32),
      BigInt(nonce),
      BigInt(balanceUser),
      BigInt(balanceOperator),
    ]
  );
}

/**
 * Verify a user's ECDSA signature over a state message.
 * @returns {boolean}
 */
function verifyUserSignature(channelId, nonce, balanceUser, balanceOperator, signature, expectedAddress) {
  try {
    init();
    const messageHash = buildStateMessage(channelId, nonce, balanceUser, balanceOperator);
    const recovered = ethers.verifyMessage(ethers.getBytes(messageHash), signature);
    const valid = recovered.toLowerCase() === expectedAddress.toLowerCase();
    if (!valid) logger.warn('Signature mismatch', { recovered, expectedAddress });
    return valid;
  } catch (err) {
    logger.error('verifyUserSignature error', { error: err.message });
    return false;
  }
}

/**
 * Sign a state message as the operator.
 */
async function operatorSignState(channelId, nonce, balanceUser, balanceOperator) {
  init();
  const messageHash = buildStateMessage(channelId, nonce, balanceUser, balanceOperator);
  const sig = await operatorWallet.signMessage(ethers.getBytes(messageHash));
  return sig;
}

// ── USDC balance helpers ──────────────────────────────────────────────────────

/**
 * Get USDC balance of an address (returns BigInt in 6-decimal units).
 */
async function getUsdcBalance(address) {
  init();
  return usdcContract.balanceOf(address);
}

/**
 * Get current Base L2 block number.
 */
async function getCurrentBlock() {
  init();
  return provider.getBlockNumber();
}

/**
 * Send USDC from the treasury to a recipient (forced refund path).
 * @param {string} toAddress
 * @param {bigint} amountWei  - USDC amount in 6-decimal wei
 */
async function sendUsdcFromTreasury(toAddress, amountWei) {
  init();
  const treasuryUsdc = usdcContract.connect(treasuryWallet);
  const tx = await treasuryUsdc.transfer(toAddress, amountWei);
  const receipt = await tx.wait();
  logger.info('Treasury USDC transfer', { txHash: receipt.hash, to: toAddress, amount: amountWei.toString() });
  return receipt.hash;
}

/**
 * Validate that a given address is a valid checksummed Ethereum address.
 */
function isValidAddress(address) {
  return ethers.isAddress(address);
}

/**
 * Convert a human-readable USDC amount (e.g. "10.5") to 6-decimal BigInt.
 */
function parseUsdc(amount) {
  return ethers.parseUnits(String(amount), 6);
}

/**
 * Convert a 6-decimal BigInt to human-readable string.
 */
function formatUsdc(amountWei) {
  return ethers.formatUnits(amountWei, 6);
}

module.exports = {
  verifyUserSignature,
  operatorSignState,
  getUsdcBalance,
  getCurrentBlock,
  sendUsdcFromTreasury,
  isValidAddress,
  parseUsdc,
  formatUsdc,
  buildStateMessage,
};
