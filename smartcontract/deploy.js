/**
 * SmartCityEscrow V3.2 — Hardhat deploy script
 * 
 * Usage:
 *   npx hardhat run smartcontract/deploy.js --network baseSepolia
 *
 * Required env vars (.env):
 *   DEPLOYER_PRIVATE_KEY  — wallet that becomes DEFAULT_ADMIN_ROLE
 *   OPERATOR_ADDRESS      — backend/operator wallet (0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7)
 *   USDC_ADDRESS          — Base Sepolia USDC (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
 */

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  const USDC_ADDRESS     = process.env.USDC_ADDRESS     || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
  const OPERATOR_ADDRESS = process.env.OPERATOR_ADDRESS || "0x1E506DE9EdEB3F7c3C1f39Edc5c38625944345C7";

  console.log("Deployer :", deployer.address);
  console.log("USDC     :", USDC_ADDRESS);
  console.log("Operator :", OPERATOR_ADDRESS);

  const Factory = await ethers.getContractFactory("SmartCityEscrow");
  const contract = await Factory.deploy(USDC_ADDRESS, OPERATOR_ADDRESS);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log("\n✅ SmartCityEscrow deployed at:", address);
  console.log("   BaseScan:", `https://sepolia.basescan.org/address/${address}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
