# Reviewer response: cost, threats, and decision flow

Scope: `go-sdk` research prototype, inspected on 2026-09-30. The comparison below is a **local Hardhat experiment**. The earlier [Base Sepolia escrow benchmark](../gas-analysis/gas-analysis.md) and [20-session E2E evidence](../e2e-validation/table3-e2e-scenarios.md) are separate measurements. No new Base Sepolia transaction or contract deployment was made for this review.

## 1. Architecture actually implemented

1. The Backend creates a DB session and passes its ID and `keccak256(utf8(sessionId))` to Go-Perun ([channelOrchestrator.js](../../smartcity-payment-backend/src/services/channelOrchestrator.js), `startSessionAndOpenChannel`; [orchestrator.go](../../go-perun-node/internal/channel/orchestrator.go), `StartSessionAndOpen`).
2. Go opens a zero-funded channel. The second Perun participant is a **server-created custodial account**, not the user's MetaMask key. The actual USDC is transferred to `SmartCityEscrow.userDeposit` and `operatorDeposit` ([channel.go](../../go-perun-node/internal/channel/channel.go), `OpenChannel`; [SmartCityEscrow.sol](../../smartcontract/SmartCityEscrow.sol), `userDeposit`/`operatorDeposit`).
3. The Backend billing scheduler counts complete minutes from `started_at`; each due minute invokes Go `ChargeUsage`, which updates signed Perun `PaymentData.FareWei` and the state version/hash. The backend persists the returned audit values ([usageBillingService.js](../../smartcity-payment-backend/src/services/usageBillingService.js), `catchUpSessionUnlocked`; [channel.go](../../go-perun-node/internal/channel/channel.go), `ChargeUsage`). This repository has no verified direct device telemetry feed in that billing path.
4. At end, the Backend freezes billing, Go finalizes or restores the channel, checks session/user identity, and exports `CurrentTX()` with both native signatures via official Perun encoding ([channelOrchestrator.js](../../smartcity-payment-backend/src/services/channelOrchestrator.js), `endSessionAndSettle`; [orchestrator.go](../../go-perun-node/internal/channel/orchestrator.go), `EndSessionAndSettle`; [proof.go](../../go-perun-node/internal/paymentapp/proof.go), `Export`). The Backend relays this proof to the escrow. The escrow derives the fare from signed appData. After the actual `CLAIM_PERIOD` of **4 minutes** and absent a dispute, `claimSettlement` distributes USDC.

## 2. Cost comparison

Baseline: each usage update is a separate `MockUSDC.transfer(user → operator, 0.1 USDC)` transaction. Proposed: `userDeposit + operatorDeposit + settleAndRelease + claimSettlement`; intermediate Perun updates incur no on-chain transaction. Both paths use the same six-decimal mock ERC-20 and local Hardhat EVM. Deployment, minting and approvals are setup excluded from both totals. The baseline lacks the proposal's escrow/dispute protections, so this is a transaction-execution comparison rather than protocol equivalence. The script constructs a final state with official Go-Perun encoding and signatures, but represents the n intermediate updates by final version/fare; it does not run n live channel updates. Each n has one local run.

| Usage updates | Baseline TX | Baseline gas | Baseline estimated L2 execution fee (ETH) | Proposed TX | Proposed gas | Proposed estimated L2 execution fee (ETH) |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 34,484 | 0.000000206904 | 4 | 635,926 | 0.000003815556 |
| 5 | 5 | 172,420 | 0.000001034520 | 4 | 635,986 | 0.000003815916 |
| 10 | 10 | 344,840 | 0.000002069040 | 4 | 635,986 | 0.000003815916 |
| 20 | 20 | 689,680 | 0.000004138080 | 4 | 635,962 | 0.000003815772 |

Fee estimate = **local gas used × 0.006 gwei/gas**, the historical average effective price in the existing Base Sepolia benchmark. It is **not a fresh Base Sepolia fee receipt** and excludes the Base L1 data fee. Local `MockUSDC` gas can differ from deployed USDC gas. The precise data and per-transaction averages are in [comparison.csv](../payment-cost-comparison/comparison.csv); the reproducible script is [compare-payment-costs.js](../../smartcontract/scripts/compare-payment-costs.js). In the tested points, the proposal first uses less gas at 20 updates; it costs more at 1, 5, and 10 updates. The proposed gas remains roughly constant as n increases.

## 3. Threat-model tests

All seven [Hardhat contract tests](../../smartcontract/test/stateBoundSettlement.test.js) pass. The table distinguishes rejected attempts from limits of the deployed design.

| Threat | Attacker | Attempt | Expected defense | Actual result |
|---|---|---|---|---|
| T1 Invalid/tampered state | User or provider | Mix a signed proof with altered appData, submit a non-final state, or use a different channel | Reject proof; preserve escrow USDC | `InvalidPerunProof`; balance and escrow state unchanged |
| T2 Stale state/replay | Provider with access to both signing keys | Submit an earlier non-final state; separately, create conflicting signed final proofs at versions 3 and 4, then submit version 3 | Reject earlier state; latest final should win | Earlier non-final state rejected. **Conflicting final proof not covered**: valid version 3 was accepted while version 4 existed only off-chain. A second settlement is rejected by `InvalidState`; a reused channel ID is rejected at deposit. |
| T3 Invalid settlement amount | User or provider | Change the fare in appData without matching signatures | Reject mismatched amount; preserve USDC | `InvalidPerunProof`; no separate caller-supplied settlement amount exists. A different fare jointly signed by both server-controlled participants cannot be distinguished as false by the contract. |
| T4 Premature claim | Provider | Claim before `claimableAfter` | Reject until dispute window ends | `ClaimPeriodNotEnded`; claim after 4 minutes succeeds |
| T5 Unauthorized refund | User / caller without operator role | Register an issue as user or refund without an issue | Reject unauthorized call and missing issue | Both rejected; no USDC movement. **Limit:** an authorized operator can register an issue without on-chain device evidence and then refund. |

Under the honest Go-Perun flow, only the last update has `IsFinal=true` and no later update is accepted. Thus ordinary older states are non-final and rejected. The two-final-proof test deliberately models **signer equivocation**: two conflicting final proofs signed for the same channel, which the honest SDK workflow does not create but a party controlling both signing keys can create. T2 cannot be solved by checking `s.version > 0` or hashing the submitted state: those values are also present in an older, correctly signed final state. Rejecting that proof on-chain requires a trusted latest-state commitment available to the contract before settlement (or a different independent participant/signing assumption). That would add an on-chain step or materially change custody and gas results, so this review does not claim such a defense or alter the deployed contract.

## 4. Exact final-state validation

| Step | File / function | Actual check or action |
|---|---|---|
| Export | `go-perun-node/internal/channel/channel.go`, `ExportFinal`; `internal/paymentapp/proof.go`, `Export` | Restores the channel, reads `CurrentTX()`, requires `IsFinal`, validates Perun app data and channel ID, verifies both native signatures, and encodes Params/State through `perun-eth-backend` |
| Relay | `smartcity-payment-backend/src/services/channelOrchestrator.js`, `endSessionAndSettle`; `escrowPayoutService.js`, `settleAndReleaseInternal` | Stops billing, forwards the native proof, checks proof byte/signature shape and asks `verifiedFare`; does not set a caller-selected fare |
| Channel/format | `smartcontract/SmartCityEscrow.sol`, `verifiedFare` | Canonical ABI re-encoding; `state.channelID == perunChannelIDs[escrowId] == keccak256(paramsABI)`; Perun app is this escrow; ledger and non-virtual flags; `isFinal` and `version > 0` |
| Participants/signatures | Same function | Exactly two distinct nonzero participant addresses; participant 0 equals stored operator; Ethereum signed-message recovery of `keccak256(stateABI)` matches both Params addresses. Participant 1 is the custodial Go user, not the MetaMask user. |
| Payment binding | Same function | One supported asset/backend, two zero Perun AssetHolder balances, no locked allocation; appData contains matching `escrowId`, Base chain ID, escrow address, stored MetaMask user, and deposited amount; fare cannot exceed deposit |
| Reservation | Same contract, `settleAndRelease` | Caller has operator role and matches escrow operator; escrow is `FullyFunded`; hold deadline passed. Emits state hash/version, stores signed fare and payout amounts, sets `Released` and `claimableAfter` |
| Claim | Same contract, `claimSettlement` | Escrow is `Released`, not already claimed, and dispute window ended; then transfers reserved USDC |

The emitted state hash/version are **audit evidence**, not an on-chain comparison with an independently stored latest final hash/version. `perunChannelIDs` is a deposit-time channel binding, not a latest-state commitment. The nonce is inside Params and therefore affects the channel ID, but is not a latest-version check. `fareAmount` is stored **after** proof verification; it is not a prior expected amount.

## 5. Actual fault and refund decision

There is no implemented end-to-end flow in which a physical service device autonomously reports authenticated telemetry, the Backend validates it, and a RefundIssue automatically follows. Normal billing uses the scheduler's elapsed minutes and Perun updates. Faults enter through refund API requests (`POST /api/v1/refunds` with a reason and optional caller-provided evidence), then `POST /:caseId/evaluate`, manual approval, or the separate proof-recovery timeout path.

In [refundDecisionEngine.js](../../smartcity-payment-backend/src/services/refundDecisionEngine.js), `sensor_failure` needs caller-provided return/end evidence and a fare record; `double_charge` queries duplicate nonces; `unlock_failure` auto-approves the requested amount or default without independent evidence; `service_outage` can auto-approve even without an outage record; `device_fault` and `wrong_charge` require manual review. Eligible amounts up to 5 USDC are approved automatically. The public [refund routes](../../smartcity-payment-backend/src/routes/refunds.js) create/evaluate/approve/pay cases; `payout` requires case status `APPROVED`, matching session/user records, and invokes the operator wallet. No authentication middleware beyond content-type/shape validation was found on these routes.

At payout, [escrowPayoutService.js](../../smartcity-payment-backend/src/services/escrowPayoutService.js), `refundToBuyer`, checks on-chain escrow state, registers `RefundIssue` via the operator wallet if needed, and submits **zero refundFare**, implementing full return of the user's deposit. The contract itself verifies operator role, allowed escrow state, dispute-window timing after reservation, and `RefundIssue` before transfer. It does **not** validate device evidence or the Backend's case reasoning; the approved case amount is not used to calculate a partial on-chain refund. Separately, when the final Perun proof remains unavailable one hour after hold deadline, [index.js](../../smartcity-payment-backend/src/index.js) and [settlementRecovery.js](../../smartcity-payment-backend/src/services/settlementRecovery.js) invoke `forceRefund`; the contract enforces its timeout. This path is recovery from missing proof, not device fault detection.

## 6. Security claims and trust boundaries

Supported: malformed/non-final/wrong-channel proof rejection; native signature and appData binding; no independent Backend fare input to settlement; deposited funds remain in escrow through the dispute window; premature and duplicate claim prevention; refund requires operator privilege and `RefundIssue` (or time-based `forceRefund`).

Not supported: on-chain knowledge of the highest signed off-chain state; independent user MetaMask signature on each Perun update; independent device evidence attestation; protection against a malicious operator who also controls the server-created custodial participant key; arbitrary refund issue registration by that authorized operator; verified automatic device failure detection. The Backend and its operator wallet/custodial node must be trusted to calculate usage, report faults, and relay the latest proof honestly. The current refund API also requires an operational authorization boundary outside these routes before being exposed to untrusted callers.

## 7. Paper-ready paragraphs

**Cost.** 동일한 로컬 EVM과 6자리 소수의 ERC-20 모의 토큰을 사용해 사용량 갱신마다 직접 전송하는 방식과 제안 방식을 비교했다. 직접 전송 방식의 온체인 트랜잭션 수는 갱신 횟수 n에 비례한 반면, 제안 방식은 사용자·운영자 예치, 최종 상태 검증을 통한 정산 예약, 분쟁 기간 이후 청구의 4건으로 일정했다. n=20에서 측정된 실행 가스는 각각 689,680 및 635,962였다. 수수료는 기존 Base Sepolia 평균 가스가격을 적용한 **추정치**이며 실제 Base Sepolia에서 baseline 결제를 반복 실행한 영수증은 아니다. 비교 대상의 에스크로·분쟁 보장 수준은 서로 다르다.

**Final state.** Go-Perun 노드는 최종 상태와 두 custodial 참가자의 서명을 공식 인코딩으로 내보낸다. SmartCityEscrow는 예치 시 결속한 채널 ID, 최종 플래그, 참가자 서명, 체인·계약·세션·사용자·예치금에 결속된 appData를 검증한 뒤 그 안의 요금만 정산 예약한다. 정상적인 Go-Perun 흐름의 과거 상태는 비최종 상태이므로 거부된다. 다만 두 서명 키를 가진 주체가 상충하는 최종 증명을 생성했다면 컨트랙트는 체인 밖에 존재하는 더 최신의 최종 상태를 알 수 없으므로, 그러한 과거 최종 증명의 선제 제출까지 방어한다고 주장하지 않는다.

**Fault/refund.** 현재 구현의 장애·과금 오류 판정은 신뢰하는 Backend의 환불 사례 생성, 규칙 평가 또는 수동 검토에 의존한다. 승인된 사례에 대해 운영자 권한으로 RefundIssue를 등록하고 에스크로에서 사용자 예치금을 환불한다. 기기 텔레메트리의 독립 인증과 자동 장애 탐지는 구현되어 있지 않으며, 증명 생성 실패에 따른 별도의 시간 초과 강제 환불이 존재한다.

## 8. Reproduction

From the repository root on Windows PowerShell:

```powershell
cd smartcontract
npm.cmd test -- --grep "SmartCityEscrow state-bound settlement"
npx.cmd hardhat run scripts/compare-payment-costs.js --network hardhat
cd ..\smartcity-payment-backend
npm.cmd test -- --runInBand
cd ..\go-perun-node
go test ./...
```

The cost script rewrites `results/payment-cost-comparison/comparison.csv` and `comparison.md`. It requires locally installed Node dependencies and Go. It does not require private keys, Base RPC access, or MetaMask. A fresh live Base Sepolia baseline needs user/operator wallet funding and explicit network credentials; none were configured in this workspace during this review.
