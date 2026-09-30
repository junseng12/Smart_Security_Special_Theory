# On-chain per-update payments vs Perun escrow

Local Hardhat EVM receipts; MockUSDC (6 decimals) for both methods. Each update transfers 0.1 USDC directly from user to operator in the baseline. The proposed path deposits 3 USDC per party, submits an official Go-Perun-encoded final proof with cumulative fare 0.1 × n, then claims after the dispute window. Its intermediate Perun updates are represented by the final version/fare and are not run by this cost script; their on-chain gas is zero. Deployment, minting and token approvals are setup transactions excluded from both totals. The baseline offers no escrow or dispute protection; this is an execution-cost comparison, not a security-equivalent protocol comparison. Each n is one local run; the existing separate Base Sepolia proposed benchmark contains ten live runs.

The fee columns are **estimated Base Sepolia L2 execution fees**, calculated as local gas × 0.006 gwei/gas (historical average from the existing Base Sepolia escrow benchmark). They are not fresh Base Sepolia transaction receipts and exclude the Base L1 data fee. The local mock token differs from deployed USDC, so do not present these as directly observed Base Sepolia totals.

| Usage updates | Baseline TX | Baseline gas | Baseline estimated fee (ETH) | Proposed TX | Proposed gas | Proposed estimated fee (ETH) |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 34484 | 0.000000206904 | 4 | 635926 | 0.000003815556 |
| 5 | 5 | 172420 | 0.00000103452 | 4 | 635986 | 0.000003815916 |
| 10 | 10 | 344840 | 0.00000206904 | 4 | 635986 | 0.000003815916 |
| 20 | 20 | 689680 | 0.00000413808 | 4 | 635962 | 0.000003815772 |

For the observed deployed-escrow gas benchmark, see [gas-analysis.md](../gas-analysis/gas-analysis.md).

Run: `cd smartcontract && npx hardhat run scripts/compare-payment-costs.js --network hardhat`. Requires Node dependencies and Go.
