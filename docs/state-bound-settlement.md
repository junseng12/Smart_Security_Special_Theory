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
