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

function liveReceiptEvidence() {
  const lines = fs.readFileSync(path.join(ROOT, 'results', 'gas-analysis', 'raw_transactions.csv'), 'utf8')
    .trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  const records = lines.slice(1).map(line => Object.fromEntries(
    line.split(',').map((value, index) => [headers[index], value]),
  ));
  const selected = records.filter(row => row.session_id === 'd815a8a8-a352-4822-ac2a-15660bc631a1');
  const names = {
    'User Deposit': '사용자 예치', 'Operator Deposit': '운영자 예치',
    'Settlement Reservation': '정산 예약', 'Settlement Claim': '최종 청구',
  };
  if (selected.length !== 4 || selected.some(row => row.success !== 'true'
      || row.escrow_id !== selected[0].escrow_id || !names[row.operation])) {
    throw new Error('실제 Base Sepolia 영수증 자료가 불완전함');
  }
  const entries = selected.map(row => `| ${names[row.operation]} | [거래 영수증](https://sepolia.basescan.org/tx/${row.tx_hash}) | ${Number(row.gas_used).toLocaleString('en-US')} |`).join('\n');
  const gas = selected.reduce((sum, row) => sum + BigInt(row.gas_used), 0n);
  return `같은 에스크로 ID(\`${selected[0].escrow_id}\`)의 Base Sepolia 거래 4건은 공개 RPC에서 함수·성공 여부·Gas를 재확인했다. **635,926 Gas는 위의 MockUSDC 로컬 합계이고, 다음 ${gas.toLocaleString('en-US')} Gas는 실제 Base Sepolia 한 세션의 합계**다.\n\n` +
    `| 실제 Base Sepolia 작업 | 거래 | Gas |\n|---|---|---:|\n${entries}\n| **실거래 합계** | **성공 거래 4건** | **${gas.toLocaleString('en-US')}** |\n\n` +
    '`userDeposit`은 새로운 에스크로 기록의 사용자·운영자·예치금·마감 시각·상태를 저장하고 Perun 채널 ID와 채널 재사용 표시를 새로 기록한다. 비어 있던 에스크로 주소로 USDC를 처음 옮기며 이벤트 2개도 남긴다. `operatorDeposit`은 이미 존재하는 기록의 운영자 예치금·상태를 갱신하고 USDC를 한 번 옮기며 이벤트 1개를 남긴다. 따라서 두 함수의 Gas는 같지 않다. 정확한 세부 Gas 비중은 토큰 구현과 저장 상태에 따라 달라진다. 전체 합계는 한 사람이 한 거래에서 지불한 Gas가 아니라 사용자 예치 거래와 운영자 측 정산 거래들을 합친 네 거래의 사용량이다.\n\n';
}

async function main() {
  const referencePrice = baseSepoliaReferencePrice();
  const rows = [];
  const operations = [];
  for (const n of COUNTS) {
    const direct = await baseline(n);
    const stateBound = await proposed(n);
    direct.forEach((receipt, index) => operations.push({
      updates: n, method: 'baseline', operation: `직접전송_${index + 1}`,
      gasUsed: receipt.gasUsed.toString(),
    }));
    ['userDeposit', 'operatorDeposit', 'settleAndRelease', 'claimSettlement']
      .forEach((operation, index) => operations.push({
        updates: n, method: 'proposed', operation,
        gasUsed: stateBound[index].gasUsed.toString(),
      }));
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
  const titles = {
    updates: '사용량갱신횟수', baselineTx: '직접전송TX수', baselineGas: '직접전송Gas',
    baselineFeeWei: '직접전송추정수수료wei', baselineAvgGas: '직접전송TX당평균Gas',
    baselineAvgFeeWei: '직접전송TX당평균추정수수료wei', proposedTx: '제안방식TX수',
    proposedGas: '제안방식Gas', proposedFeeWei: '제안방식추정수수료wei',
    proposedAvgGas: '제안방식TX당평균Gas',
    proposedAvgFeeWei: '제안방식TX당평균추정수수료wei',
  };
  fs.writeFileSync(path.join(OUT, 'comparison.csv'),
    `${keys.map(k => titles[k]).join(',')}\n${rows.map(row => keys.map(k => row[k]).join(',')).join('\n')}\n`);
  fs.writeFileSync(path.join(OUT, 'operations.csv'),
    `사용량갱신횟수,방식,작업,Gas\n${operations.map(row =>
      `${row.updates},${row.method === 'baseline' ? '직접전송' : '제안방식'},${row.operation},${row.gasUsed}`).join('\n')}\n`);
  const eth = wei => ethers.formatEther(wei);
  const table = rows.map(r => `| ${r.updates} | ${r.baselineTx} | ${r.baselineGas} | ${eth(r.baselineFeeWei)} | ${r.proposedTx} | ${r.proposedGas} | ${eth(r.proposedFeeWei)} |`).join('\n');
  const detail = operations.filter(r => r.updates === 1 && r.method === 'proposed')
    .map(r => `| ${r.operation} | ${r.gasUsed} |`).join('\n');
  fs.writeFileSync(path.join(OUT, 'comparison.md'), `# 사용량별 온체인 결제 비용 비교\n\n` +
    `두 방식 모두 로컬 Hardhat EVM과 소수점 6자리 MockUSDC로 측정했다. 기존 방식은 사용량 갱신마다 사용자에서 운영자로 0.1 USDC를 직접 전송한다. 제안 방식은 사용자와 운영자가 각각 3 USDC를 SmartCityEscrow에 예치하고, Go-Perun 공식 인코딩의 최종 증명으로 정산을 예약한 뒤 분쟁 기간 이후 청구한다. 이 스크립트는 n번의 실제 중간 Perun 업데이트를 실행하지 않고 최종 상태 버전과 누적 요금으로 나타낸다. 중간 업데이트의 온체인 TX 수는 0이다.\n\n` +
    `**제안 방식의 4 TX는 Perun 채널 개설·종료 TX가 아니다.** 사용자 예치(userDeposit), 운영자 예치(operatorDeposit), 정산 예약(settleAndRelease), 최종 청구(claimSettlement)라는 USDC 에스크로 호출이다. 현재 구현의 Perun 채널은 자금 배분이 0이므로 개설 시 온체인 예치를 건너뛰며, 정상 종료 시 Perun adjudicator 정산 TX도 보내지 않는다.\n\n` +
    `컨트랙트 배포·토큰 발행·approve는 두 방식의 준비 단계로 통계에서 제외했다. 기존 직접 전송 방식에는 에스크로·분쟁 보호가 없으므로 보안 수준까지 같은 프로토콜의 비교는 아니다. 각 n은 로컬 실험 1회이며, 별도의 Base Sepolia 제안 방식 벤치마크에는 실제 거래 10회가 있다.\n\n` +
    `수수료 열은 로컬 Gas × ${ethers.formatUnits(referencePrice, 'gwei')} gwei/Gas(기존 Base Sepolia 실험의 평균 가격)로 계산한 **L2 실행 수수료 추정치**다. 새로운 Base Sepolia 실거래 영수증이 아니며 L1 데이터 비용은 제외한다. 배포된 USDC와 MockUSDC의 Gas 사용량도 다를 수 있다.\n\n` +
    `| 사용량 갱신 횟수 | 직접 전송 TX | 직접 전송 Gas | 직접 전송 추정 수수료(ETH) | 제안 방식 TX | 제안 방식 Gas | 제안 방식 추정 수수료(ETH) |\n` +
    `|---:|---:|---:|---:|---:|---:|---:|\n${table}\n\n` +
    `갱신 1회의 제안 방식 상세값:\n\n| 에스크로 작업 | Gas |\n|---|---:|\n${detail}\n\n` +
    `모든 갱신 횟수별 작업 상세값은 [operations.csv](operations.csv), Base Sepolia의 실제 에스크로 거래 측정은 [gas-analysis.md](../gas-analysis/gas-analysis.md)를 참조한다.\n\n` +
    liveReceiptEvidence() +
    `재현 명령: \`cd smartcontract; npx.cmd hardhat run scripts/compare-payment-costs.js --network hardhat\`. Node 의존성과 Go가 필요하다.\n`);
  console.log(table);
}

main().catch(err => { console.error(err); process.exitCode = 1; });
