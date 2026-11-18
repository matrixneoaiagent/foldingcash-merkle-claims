# Findings, limitations and next steps

Written after building and running the whole thing on Chipnet. Everything here
is either measured in this repository or reproduced by one of the scripts.

## 1. A claim pays for the proof twice

Both pool UTXOs are locked by the same script, so both inputs execute
`claimChecks()` — including the two Merkle walks (old leaf → committed root, new
leaf → next root). That is the price of having the reward balance and the state
NFT in separate outputs: a BCH output can carry only one token category, so the
state NFT cannot live in the reward UTXO, and every input at a P2SH32 address
must satisfy the script.

Measured cost: 2541 bytes per claim (~700 bytes per pool input are the redeem
script plus the 180-byte proof), 299k op cost of a 794k budget per input.

**v2 fix** — split the covenant the way the CashScript modular-design guide
suggests: move the Merkle verification into a *registry* contract that holds the
root, and let the pool contract verify only token flows plus "the registry input
is a registry UTXO recreated at the registry address". The proof then appears
once (~700 bytes saved) and the pool branch becomes small. The registry can take
the pool's script hash as a constructor argument without a circular dependency,
because the pool can identify the registry purely by NFT category + commitment
(the checks it already performs).

## 2. Root mutation makes cached proofs stale

Mutating the leaf on claim (mechanism 1 for double-claim prevention) is what closes
the "claim twice by withholding the receipt" hole. The cost is that any claim by
anybody changes the root, so a proof fetched before that claim is no longer valid.

Observed: the claim CLI checks `local tree root == on-chain root` before building
and fails with a clear message otherwise; the proof server rebuilds the tree from
the chain on every request. A wallet integration must fetch a fresh proof
immediately before signing and retry on `proof does not match active root`. With
300 users claiming weekly, collisions are rare; with 100k users claiming daily
they are not, and a client should treat the proof as a short-lived lease.

Alternative considered and rejected: keep the root immutable between epochs and
let the receipt carry the claimed total. That removes staleness but re-opens the
first-claim replay hole (§4), because a stateless pool cannot know whether a
receipt already exists for a leaf.

## 3. The `claimed` column is the remaining accounting trust

At each rotation the operator writes `cumulativeClaimed` per leaf. If it writes a
value lower than the truth, the affected user can claim more than they should;
if higher, they lose money. Neither is preventable on-chain without storing
per-user state outside the tree, and both are *detectable*: `scripts/sync.ts` and
`GET /watch` replay every claim from the pool's transaction history and rebuild
the root the covenant should have. This is a strictly smaller trust surface than
today (where nothing about a payment is verifiable), and it is inside the
operator's existing power to decide `cumulativeEarned` anyway. A v2 could require
the operator to publish a hash of the claim log alongside each root, making a
mismatch impossible to hide rather than merely detectable.

## 4. Why the receipt is not the only guard (and why it is still worth having)

The obvious design — per-user receipt NFT carrying the claimed total, first claim
when no receipt exists — has a hole on a stateless chain: once a receipt exists,
a user can claim again through the "no receipt" branch by simply leaving it out of
the transaction. Nothing in the pool can tell "no receipt exists" apart from "the
receipt was not included".

The covenant closes it structurally: a claim must prove the leaf exactly as
committed, including its `claimed` field, and it rewrites that field. Replay is
impossible without receipts. The receipt then adds what the mutated root cannot:
a portable, user-held record that survives rotations, and the opt-in object for
delegated push. Both mechanisms are cheap, so both are used.

## 5. Claims pause during the audit window — on purpose

Keeping claims live while a rotation is pending would look nicer but is
griefable: every claim re-spends the state UTXO and therefore resets the BIP68
age that gates activation, and Merkle proofs are public, so anyone could keep the
pool permanently unable to activate a root by claiming tiny amounts every block.

The pause is at most `auditDelay` blocks per epoch, and cumulative roots mean
nobody loses anything by waiting. `deposit()` is also blocked during a rotation,
and it never touches the state UTXO, so there is no third way to reset the clock.

## 6. Chipnet nodes lag the Electrum-reported tip

The CSV check is evaluated against the height of the node that *accepts* the
transaction, while Electrum's `headers.subscribe` reported a tip up to 13 blocks
ahead of it. Result: a correctly signed activation was rejected with
`BIP68 sequence lock not satisfied` for ~25 minutes even though the pending UTXO
had 9+ confirmations by the index's count, and then went through unchanged.

This is an infrastructure artefact, not a contract bug, but it matters for
operators: `scripts/activate-when-ready.ts` retries with the same sequence until
the network accepts, and never weakens the requested delay. A production operator
should also alert if activation fails for longer than a few epochs.

## 7. Chipnet plumbing that cost time (useful for the next implementer)

* **CashTokens genesis needs a `vout: 0` input** and the category is that
  outpoint's txid. The first attempt failed locally with
  `creates new fungible tokens for a category without a matching genesis input`
  because the split produced several outputs and the script picked one with
  `vout: 3`. `scripts/mint.ts` now filters `vout === 0` and the README says to run
  `split` twice.
* **A mutable NFT cannot mint.** Receipt NFTs are created by the pool's state NFT,
  so it must have `minting` capability (which also allows commitment changes).
  The first compile/VM run failed with
  `creates an immutable token for a category without a matching minting token`.
* **`SignatureTemplate` is not an `Unlocker`** in CashScript 0.14: a P2PKH input
  needs `template.unlockP2PKH()`.
* **Contract functions cannot call each other**; shared logic must be a top-level
  `function`, which cannot see constructor parameters — they have to be passed
  in explicitly. That is why `claimChecks()` takes the two categories.
* **Semantic bytes casts** require `unsafe_bytes20(x)` rather than `bytes20(x)`.
* The compiler shares the Merkle loop through `OP_DEFINE`/`OP_INVOKE`, so the
  redeem script stays 457 bytes at every depth — a nice property for the depth
  scaling table in [COST.md](COST.md).

## 8. Limitations

* **Not audited.** The covenant is covered by deterministic VM tests and a full
  Chipnet run, but that is not a security review.
* **Chipnet only.** Mainnet deployment needs a real `rewardCategory` (the FLDCH
  category cannot host the state NFT, so a second category must be minted at
  deployment), real fee assumptions (1 sat/B is optimistic for busy periods), and
  a decision on `auditDelay` (144 blocks for daily epochs, 1008 for weekly).
* **Single operator key.** §"Root authority" in
  [ARCHITECTURE.md](ARCHITECTURE.md#open-questions-from-the-brief) describes the
  multisig upgrade path; it is not implemented.
* **Demo users share one mnemonic.** 300 leaves derive from one disposable test
  mnemonic. The claims are still per-key and per-address, but a production
  deployment obviously has independent keys.
* **The F@H ingestion is not built.** `scripts/gen-csv.ts` produces deterministic
  pseudo-random rewards; wiring `daily_user_summary.txt.bz2` into that CSV is the
  missing operator-side piece, along with the planned compatibility-link
  verification (the leaf format can carry a link-method tag at the cost of one
  byte per leaf).
* **No UI.** The deliverables are a CLI, a JSON HTTP server and documentation. A
  wallet integration would consume `/proof/<address>` and build the same
  transaction `scripts/claim.ts` builds.
* **Auto-claim is a script, not a daemon.** `scripts/push.ts` is a manual
  invocation; scheduling it, key management and per-user thresholds are left to
  the operator.
* **Dust policy.** The covenant requires 1000 sats on every token-carrying output
  (a common convention; not a consensus constant). If node dust rules change,
  the constant must be revisited.
