// Local, receipt-based comparison. No Base Sepolia transactions are sent.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const hre = require('hardhat');
const { ethers } = hre;

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'results', 'payment-cost-comparison');
const COUNTS = [1, 5, 10, 20];
const DEPOSIT = ethers.parseUnits('3', 6);
const PER_UPDATE = ethers.parseUnits('0.1', 6);
const OP_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const USER_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';

function proofFor({ escrowAddress, escrowId, userAddress, fare, version }) {
  const input = JSON.stringify({
    operatorKey: OP_KEY, userKey: USER_KEY, escrowAddress, escrowId, userAddress,
    chainId: '31337', deposit: DEPOSIT.toString(), fare: fare.toString(),
    nonce: '7', version, final: true,
  });
  return JSON.parse(execFileSync(process.env.GO_BINARY || 'go', ['run', './cmd/perun-proof-fixture'], {
    cwd: path.join(ROOT, 'go-perun-node'), input, encoding: 'utf8',
  }));
}

async function reset() {
  await ethers.provider.send('hardhat_reset', []);
  const [operator, user] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory('MockUSDC')).deploy();
  await token.waitForDeployment();
  await (await token.mint(user.address, DEPOSIT)).wait();
  await (await token.mint(operator.address, DEPOSIT)).wait();
  return { operator, user, token };
}

async function baseline(n) {
  const { operator, user, token } = await reset();
  const receipts = [];
  for (let i = 0; i < n; i += 1) {
    const receipt = await (await token.connect(user).transfer(operator.address, PER_UPDATE)).wait();
    if (receipt.status !== 1) throw new Error(`baseline update ${i + 1} reverted`);
    receipts.push(receipt);
  }
  if (await token.balanceOf(operator.address) !== DEPOSIT + BigInt(n) * PER_UPDATE) {
    throw new Error('baseline transfer balance mismatch');
  }
  return receipts;
}

async function proposed(n) {
  const { operator, user, token } = await reset();
  const escrow = await (await ethers.getContractFactory('SmartCityEscrow'))
    .deploy(await token.getAddress(), operator.address);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  const escrowId = ethers.keccak256(ethers.toUtf8Bytes(`cost-comparison-${n}`));
  const fare = BigInt(n) * PER_UPDATE;
  const proof = proofFor({ escrowAddress, escrowId, userAddress: user.address, fare, version: n + 1 });
  await (await token.connect(user).approve(escrowAddress, DEPOSIT)).wait();
  await (await token.connect(operator).approve(escrowAddress, DEPOSIT)).wait();

  const now = (await ethers.provider.getBlock('latest')).timestamp;
  const receipts = [];
  receipts.push(await (await escrow.connect(user).userDeposit(
    escrowId, operator.address, DEPOSIT, now + 30, proof.channelId,
  )).wait());
  receipts.push(await (await escrow.operatorDeposit(escrowId, DEPOSIT)).wait());
  await ethers.provider.send('evm_increaseTime', [31]);
  await ethers.provider.send('evm_mine', []);
  receipts.push(await (await escrow.settleAndRelease(
    escrowId, proof.paramsABI, proof.stateABI, proof.signatures,
  )).wait());
  await ethers.provider.send('evm_increaseTime', [4 * 60 + 1]);
  await ethers.provider.send('evm_mine', []);
  receipts.push(await (await escrow.claimSettlement(escrowId)).wait());
  if (receipts.some(r => r.status !== 1)) throw new Error('proposed transaction reverted');
  if (await token.balanceOf(user.address) !== DEPOSIT - fare
      || await token.balanceOf(operator.address) !== DEPOSIT + fare
      || !(await escrow.getSettlementClaim(escrowId))[4]) {
    throw new Error('proposed payout mismatch');
  }
  return receipts;
}

function totalGas(receipts) {
  return receipts.reduce((sum, r) => sum + r.gasUsed, 0n);
}

function baseSepoliaReferencePrice() {
  // Same effective price observed in the existing ten-run Base Sepolia benchmark.
  const summary = fs.readFileSync(path.join(ROOT, 'results', 'gas-analysis', 'summary.csv'), 'utf8');
  const header = summary.trim().split(/\r?\n/)[0].split(',');
  const row = summary.trim().split(/\r?\n/).find(line => line.startsWith('User Deposit,'));
  if (!row) throw new Error('Base Sepolia gas-price reference missing');
  const gwei = row.split(',')[header.indexOf('mean_effective_gas_price_gwei_per_gas')];
  return ethers.parseUnits(gwei, 'gwei');
}

async function main() {
  const referencePrice = baseSepoliaReferencePrice();
  const rows = [];
  for (const n of COUNTS) {
    const direct = await baseline(n);
    const stateBound = await proposed(n);
    const bg = totalGas(direct);
    const pg = totalGas(stateBound);
    rows.push({
      updates: n, baselineTx: direct.length, baselineGas: bg.toString(),
      baselineFeeWei: (bg * referencePrice).toString(),
      baselineAvgGas: (bg / BigInt(direct.length)).toString(),
      baselineAvgFeeWei: (bg * referencePrice / BigInt(direct.length)).toString(),
      proposedTx: stateBound.length, proposedGas: pg.toString(),
      proposedFeeWei: (pg * referencePrice).toString(),
      proposedAvgGas: (pg / BigInt(stateBound.length)).toString(),
      proposedAvgFeeWei: (pg * referencePrice / BigInt(stateBound.length)).toString(),
    });
  }
  fs.mkdirSync(OUT, { recursive: true });
  const keys = Object.keys(rows[0]);
  fs.writeFileSync(path.join(OUT, 'comparison.csv'),
    `${keys.join(',')}\n${rows.map(row => keys.map(k => row[k]).join(',')).join('\n')}\n`);
  const eth = wei => ethers.formatEther(wei);
  const table = rows.map(r => `| ${r.updates} | ${r.baselineTx} | ${r.baselineGas} | ${eth(r.baselineFeeWei)} | ${r.proposedTx} | ${r.proposedGas} | ${eth(r.proposedFeeWei)} |`).join('\n');
  fs.writeFileSync(path.join(OUT, 'comparison.md'), `# On-chain per-update payments vs Perun escrow\n\n` +
    `Local Hardhat EVM receipts; MockUSDC (6 decimals) for both methods. Each update transfers 0.1 USDC directly from user to operator in the baseline. The proposed path deposits 3 USDC per party, submits an official Go-Perun-encoded final proof with cumulative fare 0.1 × n, then claims after the dispute window. Its intermediate Perun updates are represented by the final version/fare and are not run by this cost script; their on-chain gas is zero. Deployment, minting and token approvals are setup transactions excluded from both totals. The baseline offers no escrow or dispute protection; this is an execution-cost comparison, not a security-equivalent protocol comparison. Each n is one local run; the existing separate Base Sepolia proposed benchmark contains ten live runs.\n\n` +
    `The fee columns are **estimated Base Sepolia L2 execution fees**, calculated as local gas × ${ethers.formatUnits(referencePrice, 'gwei')} gwei/gas (historical average from the existing Base Sepolia escrow benchmark). They are not fresh Base Sepolia transaction receipts and exclude the Base L1 data fee. The local mock token differs from deployed USDC, so do not present these as directly observed Base Sepolia totals.\n\n` +
    `| Usage updates | Baseline TX | Baseline gas | Baseline estimated fee (ETH) | Proposed TX | Proposed gas | Proposed estimated fee (ETH) |\n` +
    `|---:|---:|---:|---:|---:|---:|---:|\n${table}\n\n` +
    `For the observed deployed-escrow gas benchmark, see [gas-analysis.md](../gas-analysis/gas-analysis.md).\n\n` +
    `Run: \`cd smartcontract && npx hardhat run scripts/compare-payment-costs.js --network hardhat\`. Requires Node dependencies and Go.\n`);
  console.log(table);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
