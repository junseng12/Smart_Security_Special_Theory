# SmartCityEscrow Gas Benchmark

## Environment

- Branch / commit: go-sdk / 16721301
- Network: Base Sepolia (chainId 84532)
- SmartCityEscrow: `0x39BA0eEc04C6A6472ecA98971f9f56Aa9DD46039`
- USDC: `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- Benchmark user: `0x579c4467d1eFC1EdB957FB178Bee9Ee6B3c9E8c4`
- User/operator deposit: 3 USDC each
- Service: bicycle
- CLAIM_PERIOD: 240 seconds
- Standard deviation: sample standard deviation (n-1)

## Results

| Operation | N | Mean gas (gas units) | Median | Stddev | Min | Max | CV | Avg gas price (gwei/gas) | Avg L2 execution fee (wei) | Avg L2 execution fee (ETH) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| User Deposit | 10 | 237201.40 | 237205.00 | 5.80 | 237193 | 237205 | 0.0024% | 0.006000 | 1423208400000 | 0.000001423208400 |
| Operator Deposit | 10 | 91314.60 | 91797.00 | 1517.06 | 86997 | 91797 | 1.6614% | 0.006000 | 547887600000 | 0.000000547887600 |
| Settlement Reservation | 10 | 211913.20 | 211918.00 | 14.09 | 211894 | 211930 | 0.0066% | 0.006000 | 1271479200000 | 0.000001271479200 |
| Settlement Claim | 10 | 104644.60 | 104647.00 | 5.06 | 104635 | 104647 | 0.0048% | 0.006000 | 627867600000 | 0.000000627867600 |
| Dispute Registration | 10 | 106124.00 | 106124.00 | 0.00 | 106124 | 106124 | 0.0000% | 0.006000 | 636744000000 | 0.000000636744000 |
| Refund Execution | 10 | 113325.00 | 113325.00 | 0.00 | 113325 | 113325 | 0.0000% | 0.006000 | 679950000000 | 0.000000679950000 |
| Deposit Total | 10 | 328516.00 | 329002.00 | 1515.82 | 324202 | 329002 | 0.4614% | 0.006000 | 1971096000000 | 0.000001971096000 |
| Settlement Total | 10 | 316557.80 | 316565.00 | 18.07 | 316529 | 316577 | 0.0057% | 0.006000 | 1899346800000 | 0.000001899346800 |

- Successful measured transactions: 60
- Failures: 0
- Operations extended to 30 samples because CV >= 5%: none
- Highest mean-gas operation: User Deposit (237201.40)
- Final-state verification problems: none

## Method and interpretation

Each operation used ten successful Base Sepolia receipts from fresh escrow and Perun channel identifiers. Failed transactions are excluded from statistics and recorded separately. Log queries were split into ranges of at most ten blocks to remain compatible with the RPC provider. Every normal-flow sample used the Backend to Go-Perun finalization path and the deployed contract verified the encoded Params, final State, two native participant signatures, and PaymentData appData before reserving settlement. Final verification confirmed settlementClaimed for normal flows and Refunded for refund flows.

These values measure the additional on-chain execution cost of the SmartCityEscrow design. They do not measure off-chain Go-Perun state update throughput. The average effective gas price is receipt-weighted and reported in gwei per gas. Average L2 execution fee is calculated per receipt as gasUsed multiplied by effective gas price and then averaged. It excludes the separate Base L1 data fee. Gas price and transaction fees vary with network conditions, so gasUsed remains the primary comparison value. settleAndRelease includes ABI decoding, native signature verification, appData binding checks, and settlement reservation.

## Setup transactions excluded from statistics

- Benchmark user ETH funding: 0x219f7a3563ab5a9eb75966abf01d49dde16c43340d4e5f6f7a8e6d92fb4e6332 (gas 21000)
- Benchmark user USDC funding: 0xcdc7564bb2470b5e819cac1feb3d2131b6ddc78a1128a9ac07a23a1036a06034 (gas 45059)
- Benchmark user ETH funding: 0x754b85a9fb07df5d887d2016918ec52903ea9da457235ccdec613a131c0e461e (gas 21000)
- Benchmark user USDC funding: 0xa053030ae5663caf7430ec230d778f6e73b865ed0dc90b2b27966c85becf1925 (gas 45059)
- Benchmark user ETH funding: 0xff4b9b0bdad5fd65c6ba4c61801ac9e1694817d786e4b77d5455455744e7cc0a (gas 21000)
