# State-bound settlement

## Phase 0 inspection (before implementation)

Base: ca8c59d2. Worktree branch: feature/state-bound-settlement.

Inspected channel.go, orchestrator.go, setup.go, transport/server.go, both
smartcity.proto files, perunClient.js, channelOrchestrator.js,
escrowPayoutService.js, and smartcontract/SmartCityEscrow.sol.

Findings: zero Perun balances were incorrectly transferred for usage; NoApp
was used; stateDigest was a channel/version label; Go used an XOR simpleHash
while Node used the DB session's Keccak ID; user_final_sig transported an
arbitrary backend fare. EndSession attempted AssetHolder settlement although
USDC is held in escrow. Node fallback could settle without Perun. Node treated
Released as payout completion, while the source contract reserves settlement.
The actual CLAIM_PERIOD is 4 minutes (not the 24 hours mentioned in comments).
Go's second participant is custodial, not the user's MetaMask account.

Pinned source inspected in the Go module cache:

| API | Confirmed contract |
| --- | --- |
| go-perun v0.15.0 client.WithApp | (channel.App, channel.Data) ProposalOpts |
| channel.Data | MarshalBinary, UnmarshalBinary, deep Clone() Data |
| channel.StateApp | Def, NewData, ValidInit, ValidTransition(params, from, to, actor) |
| RegisterApp / Resolve | process-global app ID registry; register before decoding |
| Client.EnablePersistence | accepts persistence.PersistRestorer, once before use |
| PersistRestorer.RestoreChannel | (context.Context, channel.ID) (*persistence.Channel, error) |
| CurrentTX() | on channel.Source/persisted channel, NOT public client.Channel; State and complete Sigs |
| eth-backend v0.6.0 ToEthState / ToEthParams | return adjudicator binding structs |
| EncodeState / EncodeParams | pointer to binding struct; returns ABI bytes and error |
| HashState | Keccak256(EncodeState(ToEthState(s))) |
| native Sign / Verify | official EncodeState then wallet.SignData / VerifySignature |

The pinned ABI includes Participant(address ethAddress, bytes ccAddress),
Asset(uint256 chainID,address ethHolder,bytes ccHolder), allocation backends,
uint64 state version, and uint16 suballocation index maps. Solidity tuple
definitions must match those bindings, not older Perun contract releases.
wallet.PrefixedHash hashes ABI bytes, then hashes the Ethereum signed-message
prefix for a 32-byte hash. No EIP-712 or custom backend settlement signature.

No Railway or public-chain deployment is part of this change.

## Implementation status (2026-09-16)

The state-bound settlement flow is implemented end to end:

- SmartCityEscrow remains the only USDC custody layer.
- The canonical DB session ID and its Keccak escrow ID are passed to Go-Perun.
- PaymentData carries the escrow ID and cumulative fare in signed appData.
- The Go node exports official Params ABI, State ABI, and two native signatures.
- The backend relays that proof without accepting a caller-supplied settlement fare.
- SmartCityEscrow verifies the proof, extracts the fare, reserves settlement, and
  preserves the dispute/refund window before claim.
- The main Railway backend performs both settlement reservation and the final
  claim after the dispute window.
- One-minute usage updates are driven by the backend. The browser reads the
  persisted Perun nonce and does not own the billing clock.
- Each successful usage update stores its nonce, state hash, delta fare, and
  derived balances in PostgreSQL for audit.

The current prototype has explicit trust and recovery boundaries that must be
stated accurately in the paper:

1. The second Perun participant is a custodial Go client created inside the same
   process as the operator. It is not the user's MetaMask account and it accepts
   updates automatically. The final proof therefore demonstrates native Perun
   state binding, but not independent end-user authorization.
2. The two participants communicate through go-perun LocalBus. There is no
   remote P2P user node in the current deployment.
3. The per-session custodial user key and live client are held in memory. The
   operator persistence database can export an already signed final transaction,
   but a process restart cannot safely resume an active channel without durable
   user-key/client restoration.
4. SmartCityEscrow owns the real dispute/refund window. The zero-funded Perun
   AssetHolder is intentionally not used for custody or unilateral settlement.
5. Automated tests cover encoding, signature verification, tamper rejection,
   zero-funding, billing cadence, audit persistence, refund, and claim behavior.
   A repeatable external E2E test should still assert every DB, Go, contract, and
   wallet balance transition from a fresh frontend payment.

If the paper promises a fully non-custodial state channel, items 1-3 are required
future work. If it presents a state-bound escrow prototype with a custodial
co-signer, the implemented trust model should be described explicitly rather
than implying that MetaMask signs every one-minute update.
