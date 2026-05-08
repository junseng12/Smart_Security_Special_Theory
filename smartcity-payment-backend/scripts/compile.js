/**
 * SmartCityEscrow.sol 컴파일 스크립트
 * 실행: node scripts/compile.js
 */
const solc   = require('solc');
const fs     = require('fs');
const path   = require('path');

const CONTRACT_PATH = path.join(__dirname, '../contracts/SmartCityEscrow.sol');
const ARTIFACT_DIR  = path.join(__dirname, '../artifacts');

function findImports(importPath) {
  // node_modules/@openzeppelin/... 해석
  const candidates = [
    path.join(__dirname, '../node_modules', importPath),
    path.join(__dirname, '../node_modules/@openzeppelin/contracts',
      importPath.replace('@openzeppelin/contracts/', '')),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { contents: fs.readFileSync(p, 'utf8') };
  }
  return { error: `File not found: ${importPath}` };
}

async function main() {
  console.log('\n🔨 SmartCityEscrow.sol 컴파일 중...\n');

  const source = fs.readFileSync(CONTRACT_PATH, 'utf8');

  const input = {
    language: 'Solidity',
    sources: { 'SmartCityEscrow.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        'SmartCityEscrow.sol': {
          'SmartCityEscrow': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'],
        },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  // 에러 확인
  const errors = (output.errors || []).filter(e => e.severity === 'error');
  const warnings = (output.errors || []).filter(e => e.severity === 'warning');

  if (warnings.length) {
    warnings.forEach(w => console.log('⚠️  Warning:', w.formattedMessage?.split('\n')[0]));
  }
  if (errors.length) {
    errors.forEach(e => console.error('❌ Error:', e.formattedMessage));
    process.exit(1);
  }

  const contract = output.contracts['SmartCityEscrow.sol']['SmartCityEscrow'];
  if (!contract) { console.error('❌ 컴파일 결과 없음'); process.exit(1); }

  const artifact = {
    contractName: 'SmartCityEscrow',
    abi:          contract.abi,
    bytecode:     '0x' + contract.evm.bytecode.object,
    deployedBytecode: '0x' + contract.evm.deployedBytecode.object,
    compiledAt:   new Date().toISOString(),
  };

  if (!fs.existsSync(ARTIFACT_DIR)) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(path.join(ARTIFACT_DIR, 'SmartCityEscrow.json'), JSON.stringify(artifact, null, 2));

  console.log('✅ 컴파일 완료!');
  console.log('   ABI 함수 수:', artifact.abi.filter(x => x.type === 'function').length);
  console.log('   이벤트 수:',   artifact.abi.filter(x => x.type === 'event').length);
  console.log('   Bytecode 크기:', (artifact.bytecode.length / 2).toLocaleString(), 'bytes');
  console.log('   저장:', path.join(ARTIFACT_DIR, 'SmartCityEscrow.json'));
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
