/**
 * SmartCityEscrow 배포 스크립트 — Base Sepolia
 * 실행: node scripts/deploy.js
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs   = require('fs');
const path = require('path');

const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Base Sepolia USDC

async function main() {
  console.log('\n🚀 SmartCityEscrow 배포 시작 — Base Sepolia\n');

  const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
  const wallet   = new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);

  console.log('📍 배포자(Operator):', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log('💰 잔액:', ethers.formatEther(bal), 'ETH');

  const network = await provider.getNetwork();
  console.log('🌐 네트워크:', network.name, '(chainId:', network.chainId.toString() + ')\n');

  // Artifact 로드
  const artifactPath = path.join(__dirname, '../artifacts/SmartCityEscrow.json');
  if (!fs.existsSync(artifactPath)) {
    throw new Error('artifacts/SmartCityEscrow.json 없음 — 먼저 node scripts/compile.js 실행 필요');
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  // 가스 추정
  const deployTx = await factory.getDeployTransaction(USDC_ADDRESS, wallet.address);
  const gasEst   = await provider.estimateGas(deployTx);
  const feeData  = await provider.getFeeData();
  const estCost  = gasEst * (feeData.maxFeePerGas || feeData.gasPrice || 0n);
  console.log('⛽ 예상 가스:', gasEst.toString());
  console.log('💸 예상 비용:', ethers.formatEther(estCost), 'ETH\n');

  console.log('📦 컨트랙트 배포 중...');
  const contract = await factory.deploy(USDC_ADDRESS, wallet.address, {
    gasLimit: gasEst * 120n / 100n, // 20% 여유
  });

  const txHash = contract.deploymentTransaction().hash;
  console.log('⏳ TX Hash:', txHash);
  console.log('   확인 대기 중 (최대 2분)...\n');

  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log('═'.repeat(55));
  console.log('✅ 배포 완료!');
  console.log('📌 컨트랙트 주소:', contractAddress);
  console.log('🔗 Explorer:');
  console.log(`   https://sepolia.basescan.org/address/${contractAddress}`);
  console.log('🔗 TX:');
  console.log(`   https://sepolia.basescan.org/tx/${txHash}`);
  console.log('═'.repeat(55));
  console.log('\n.env에 아래 값을 추가하세요:');
  console.log(`ESCROW_CONTRACT_ADDRESS=${contractAddress}`);
  console.log(`USDC_CONTRACT_ADDRESS=${USDC_ADDRESS}`);
  console.log(`OPERATOR_ADDRESS=${wallet.address}\n`);

  return contractAddress;
}

main().catch(e => {
  console.error('\n❌ 배포 실패:', e.message);
  process.exit(1);
});
