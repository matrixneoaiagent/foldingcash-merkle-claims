# Architecture

## The problem in one paragraph

FoldingCash pays Folding@home contributors in FLDCH. Today the operator computes
each user's share off-chain and pushes tokens to every user about once a month:
cost grows with users x distributions, the operator locks dust in every pushed
output, users must trust the operator's arithmetic, and nobody can verify a
payment before it happens. This design keeps FoldingCash as the F@H oracle but
moves the last step on-chain: the operator publishes a Merkle root of
`(address, cumulative earned, cumulative claimed)`, and each user withdraws their
own entitlement with a proof, whenever they want, at their own expense.

## On-chain objects

```
                     ┌──────────────────────────────────────────────┐
   operator key ────▶│  RewardPool  (P2SH32, one address)           │
                     │                                              │
                     │  UTXO A  reward tokens  (CATEGORY_FLDCH)     │
                     │  UTXO B  state NFT      (CATEGORY_RECEIPT)   │
                     │          commitment = activeRoot(20)         │
                     │                     || pendingRoot(20)       │
                     └──────────────────────────────────────────────┘
                                    │
                                    │ claim(proof)
                                    ▼
   user  ──▶  payout tokens  +  receipt NFT (addrHash || cumulative claimed)
```

A BCH output can carry only one token category, so the reward balance (UTXO A)
and the pool state (UTXO B) are two outputs of the same contract address. Both
are spent in the same transaction, so neither can leave without the other, and
each of them runs the same script — every rule in `claim()` is a statement about
the whole transaction, so a claim is atomic across both UTXOs.

Address of the demo deployment:
`bchtest:pdxtzth4sqfkkt9pr6gkctaz5xatgwwlt5utge2jgkyhjp9nw3spcwhq6uax2`
(redeem script 457 bytes, 736 bytes including constructor arguments).

## Leaves and tree

```
leaf   = hash160( 0x00 || addrHash(20) || cumulativeEarned(8 LE) || cumulativeClaimed(8 LE) )
node   = hash160( 0x01 || left(20) || right(20) )
```

* `addrHash` is `hash160(lockingBytecode)` of the user's address, so any address
  type works (P2PKH, P2SH32, …) and the contract can check it with a single
  `hash160(tx.outputs[i].lockingBytecode) == addrHash`.
* Cumulative amounts mean a new root supersedes the old one: a user can skip
  epochs and claim everything at once.
* `cumulativeClaimed` is what makes multi-epoch accounting safe: a claim pays
  `earned - claimed` and rewrites the leaf to `(earned, earned)`.
* `hash160` (20-byte nodes) halves the proof size compared to 32-byte nodes. The
  trade-off is 160-bit security, the same as P2SH20, and the preimages differ in
  length (37 vs 41 bytes) *and* carry a domain tag, so leaves and inner nodes
  cannot be confused.
* The tree is a **perfect binary tree of fixed depth** `DEPTH` (compile-time
  constant, 9 in the demo = 512 slots): the leaf set is sorted by `addrHash` and
  padded with the EMPTY leaf. Every proof is exactly `DEPTH * 20` bytes, the
  contract's loop is unrolled at compile time, and the operator's tree builder
  and the contract agree on one canonical root.
* `path` is an integer bitmask: bit *i* set means "the node is the right child at
  level *i*".

## Claim transaction shape

```
in  0  pool reward UTXO      (has CATEGORY_FLDCH tokens)
in  1  pool state UTXO       (has the minting state NFT)
in  2  receipt NFT           (only for claims after the first one)
in  3+ claimant BCH inputs   (fee + dust, user-funded)
out 0  payout                tokens, amount = earned - claimed, to the leaf address
out 1  pool reward UTXO      tokens, amount = in0 - payout
out 2  pool state UTXO       same NFT, commitment = newRoot || 0
out 3  receipt NFT           immutable, commitment = addrHash || earned
out 4  claimant change       no tokens
```

Measured: 2541 bytes for a first claim, 2686 bytes for a receipt claim, 299k op
cost out of a 794k budget per input (see [COST](COST.md) and
[depth analysis](#merkle-depth-and-vm-limits)).

## Double-claim prevention

Three independent mechanisms, in order of strength:

1. **The root is rewritten in place.** A claim recomputes the root twice: once
   with the leaf as published (must equal the committed `activeRoot`) and once
   with the leaf flipped to `(earned, earned)`, which becomes the new committed
   root. Replaying the same proof recomputes the *old* root, which is no longer
   committed, so the covenant rejects it — before any receipt is involved.
2. **The receipt NFT.** Each claim burns the user's receipt and re-mints it with
   `commitment = addrHash || cumulativeEarned`. A repeat claim must hand the
   receipt back, and the covenant requires the receipt's commitment to equal the
   leaf's `claimed` field exactly. The receipt is therefore a user-held,
   portable audit record of everything that user has withdrawn, and it is the
   opt-in vehicle for delegated push (below).
3. **The receipt is not hideable *and* not forgeable.** Only the pool's mutable
   state NFT can mint receipt NFTs, and only inside a valid claim (fixed output
   count, fixed commitment, fixed recipient). A user cannot mint a receipt with
   an arbitrary total, cannot alter an existing one (capability `none` = the
   commitment is frozen), and cannot claim without one once `claimed > 0`
   (`claim(..., withReceipt=false)` requires `claimed == 0` in the leaf).

Why mutation *and* receipts? A receipt-only design has a hole: a user could
claim once (minting a receipt) and then claim again through the "first claim"
path by simply not including the receipt. That hole can only be closed by the
pool having per-leaf state, which on a stateless UTXO chain means mutating the
committed root — exactly what mechanism 1 does. The receipt then adds what the
mutable root cannot: a portable record that survives root rotations, independent
of the operator's bookkeeping.

The residual trust is honest and documented: at each rotation the operator
writes the `cumulativeClaimed` column, and a wrong value there (lower than the
truth) is what a user could exploit. That is inside the operator's existing power
(it already decides `cumulativeEarned`), it is visible on-chain, and
`scripts/sync.ts` + `GET /watch` recompute every leaf's claimed total from the
claim history so any mismatch is detectable by anyone.

## Root rotation and the audit window

Rotation is two-phase, so a new root is never claimable before watchers had time
to check it:

```
phase 1  proposeRoot(newRoot)      activeRoot || pendingRoot     claims pause
         ... auditDelay blocks ...  (BIP68 relative locktime, enforced by nodes)
phase 2  activateRoot()            pendingRoot || 0              claims resume
         cancelRoot()              activeRoot || 0               operator abort
```

* `activateRoot` contains `require(this.age >= auditDelay)`. `this.age` compiles
  to `OP_CHECKSEQUENCEVERIFY` against the *pending UTXO's own* BIP68 relative
  locktime, so the delay is enforced by consensus, not by the operator's clock:
  the state UTXO must have been sitting untouched for `auditDelay` blocks.
  Nothing else can spend that UTXO in the meantime — `claim()` refuses while a
  rotation is pending, and `deposit()` never touches the state UTXO — so nobody
  can reset the clock by re-spending it.
* Claims are paused during the window. That is a deliberate trade: it is what
  makes the CSV anchor impossible to grief. A design where claims stay live
  would let anyone (proofs are public) re-spend the state UTXO every block and
  starve the activation forever. The pause costs at most `auditDelay` blocks of
  latency per epoch; cumulative roots mean nobody loses anything by waiting.
* `cancelRoot` restores the previous root with no delay, since it can only
  restore something that was already live.
* Watchers can recompute the proposed root from the published leaf snapshot, and
  `scripts/sync.ts` proves the live root after claiming is exactly the published
  leaves plus the claim history.

The demo uses `auditDelay = 2` blocks so the rejection is observable inside a
demo session. Production: 144 blocks (about one day) for a daily epoch, or 1008
blocks (a week) for a monthly epoch — the value is a constructor argument, so it
is fixed for the life of a deployment.

## User-funded dust

Every token-carrying output needs 1000 satoshis: the payout (out 0), the pool's
reward UTXO (out 1), the state UTXO (out 2) and the receipt (out 3). The
claimant's inputs pay for all of them plus the fee, and the change returns to the
claimant. The operator pays nothing per claim — which is exactly the dust it
funds today for every pushed output. The two outputs that stay with the claimant
(payout + receipt) keep 2000 sats of *their own* money, which they recover when
they spend them.

## Operator push path (optional)

The bounty asks for an optional push path with a minimum threshold. Because the
receipt is an ordinary NFT, a user can move it into a small delegation covenant
(`contracts/ReceiptHold.cash`) once and then have the operator submit claims for
them:

* `release(pk, sig)` — the owner can always take the receipt back.
* `delegated(operatorSig)` — the operator may spend the receipt only inside a
  well-formed claim (receipt input at index 2, receipt output back to the same
  delegation address, recorded total must increase by at least `minPush`).

Payouts can only go to the address committed in the leaf, so delegation never
gives the operator custody. The threshold is enforced on-chain, which is what
keeps pushes from being wasted on dust-sized balances — the exact problem the
bounty describes from the FoldingCoin era.

## Trust boundaries

| Component | Trust |
|---|---|
| F@H daily stats file | trusted (as before) |
| Inclusion rules, compatibility-link mapping | trusted (as before) |
| `cumulativeEarned` per leaf | trusted, but now *auditable*: the root is public and the operator must publish its leaf set |
| `cumulativeClaimed` per leaf at rotation | trusted, but recomputable from the claim history (`/watch`) |
| Token custody | **not** trusted: the covenant cannot pay anyone but the leaf address, cannot change the pool balance except by verified payouts, and gives the operator no sweep path |
| Root update timing | **enforced by consensus** during the audit window |
| Root *content* | trusted but auditable: the operator can inflate a leaf (it already decides entitlements) or propose a root that contradicts the claim log. Both are visible to any watcher before or after the fact; neither is preventable on-chain. |
| Liveness | the operator can freeze claims by proposing a root and never activating it (`cancelRoot` is the way back). It cannot steal, and cannot spend the pool. |

## Open questions from the brief

* **Epoch identity.** There is no epoch counter on-chain: the 40-byte state
  commitment is fully used by `activeRoot || pendingRoot`, and the root *is* the
  epoch identifier. The human-readable epoch number lives in the published leaf
  snapshot (`demo/epochs/epoch-N.published.json`), and the watcher maps roots to
  epochs by recomputing them — so an epoch number can never disagree with the
  chain. A deployment that wants an on-chain counter can shorten the roots to 19
  bytes and spend the freed byte on an epoch index, at the cost of 8 bits of
  security.
* **Epoch cadence.** Weekly. Roots are cheap (one 1174-byte propose + one
  1153-byte activate), claims are cumulative, and a week is short enough that a
  user's balance is never far behind. Daily roots cost the same per epoch but
  pause claims more often; monthly roots delay access, which is the current
  problem.
* **Scale.** `DEPTH` is a compile-time constant. Bytecode size is constant in
  `DEPTH` (the loop body is shared through `OP_DEFINE`); only the proof grows,
  40 bytes per level across the two pool inputs. Measured: depth 9 (512 slots)
  = 2543-byte claim; depth 14 (16,384) = 2745 bytes; depth 18 (262,144) = 2909
  bytes, still 537k / 940k op cost. 262k users per epoch is comfortably inside
  every VM limit.
* **Root authority.** A single operator key in this version. Because the
  contract takes a `pubkey`, moving to a threshold is a matter of accepting a
  multisig script hash instead (`checkMultiSig` on a 2-of-3), or wrapping the
  operator in a P2SH32 that only signs when 2 of 3 keys agree. Note the operator
  can never move funds; the authority is only over which root is active and when.
* **Receipt commitment layout.** `addrHash(20) || cumulativeEarned(8 LE)` = 28
  bytes, immutable capability. 8 bytes LE because the covenant's
  `toPaddedBytes(x, 8)` and the tree's `encodeU64` agree.
* **Leaf contents / link verification.** Left as a v2 item: a leaf could carry a
  one-byte link-method tag (0 = address in the F@H username, 1 = proven
  compatibility link) at the cost of 1 byte per leaf, letting a watcher know
  which leaves it can re-derive from public F@H data. Publishing each compatibility
  link's evidence (signature, nonce) next to the leaf snapshot is the natural
  extension; the Merkle root itself is unchanged.
* **Merkle depth vs VM limits.** See the table above and
  `scripts/depth-analysis.ts`.
