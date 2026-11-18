# FoldingCash pull claims — Merkle reward pool on Bitcoin Cash

**BCH BLAZE 2026 · bounty "Trust-minimized, pull-based reward claims for
FoldingCash"** · Chipnet only, no mainnet, no real funds.

FoldingCash currently pays Folding@home contributors with a trusted monthly token
push: the operator computes everyone's share off-chain and sends tokens to every
user, so cost grows with users × distributions and each payment has to be taken
on faith. This repository replaces that last step with an on-chain Merkle pool:

* the operator publishes a root of `(addressHash, cumulativeEarned, cumulativeClaimed)`
  per epoch and nothing else;
* each user withdraws their own entitlement with a Merkle proof, whenever they
  like, paying their own fee and token dust;
* a per-user **receipt NFT** records the cumulative claimed total, so a claim can
  never be repeated;
* the pool rewrites the claimed leaf on every claim, so a replayed proof is
  rejected by the covenant itself;
* a new root only becomes claimable after a **hard, consensus-enforced audit
  window** (`OP_CHECKSEQUENCEVERIFY`);
* an **optional operator push path** exists for users who never claim, with the
  minimum push threshold enforced on-chain.

Everything in this repository was run end to end on Chipnet: real genesis
transactions, a real 300-leaf tree, real claims, real rejections. Txids and
explorer screenshots are in [docs/DEMO.md](docs/DEMO.md).

| | |
|---|---|
| Pool contract (Chipnet) | `bchtest:pdxtzth4sqfkkt9pr6gkctaz5xatgwwlt5utge2jgkyhjp9nw3spcwhq6uax2` |
| Reward token (FLDCH stand-in) | `7ce27f71745efcb5627a7ce054368e7f8adf92a38314f3bfc9b831c1c0a43e5f` |
| Receipt / state NFT category | `583189b036530cf05e5cf15bd1be7add4a0055c20fa4cdeb0f022fdb42384e97` |
| Leaves / Merkle depth | 300 / 9 (512 slots) |
| Redeem script | 457 bytes (736 with constructor arguments) |
| Claim transaction | 2541 bytes, 299k / 794k op cost per input |

## How it works

```
     CSV: address, cumulative earned        ┌────────────── RewardPool (P2SH32) ─────────────┐
              │                             │  UTXO A: 1,000,000 reward tokens               │
              ▼                             │  UTXO B: minting state NFT                     │
   merkle tree (fixed depth 9) ──root──▶    │          commitment = activeRoot || pendingRoot│
              │                             └────────────────────────────────────────────────┘
              │ proof                                    ▲                    │
              ▼                                          │ new root           │ payout + receipt
   claim(addrHash, earned, claimed, proof, path, withReceipt)                  ▼
                                              user's address  +  receipt NFT (addrHash || earned)
```

* **Merkle leaves** are `hash160(0x00 || addrHash(20) || earned(8) || claimed(8))`,
  inner nodes `hash160(0x01 || left || right)`. The tree is padded to `2^DEPTH`
  slots, so every proof is exactly `DEPTH * 20` bytes.
* A claim proves the leaf against the committed `activeRoot`, pays
  `earned - claimed` **to the address committed in the leaf** (the covenant
  checks `hash160(output.lockingBytecode)`), rewrites the leaf to
  `(earned, earned)` and commits the new root. A replay recomputes the old root,
  which is no longer committed → rejected.
* **Receipts**: the first claim mints an immutable NFT with commitment
  `addrHash || cumulativeEarned`; every later claim must hand it back, and the
  covenant requires its commitment to match the leaf's `claimed` value exactly.
* **Rotation** is two-phase: `proposeRoot` commits `activeRoot || pendingRoot`
  and pauses claims, then after `auditDelay` blocks `activateRoot` promotes it.
  The delay is a BIP68 relative locktime on the pending UTXO, so it is enforced
  by nodes — not by the operator's clock.
* **Operator push**: a user can move their receipt into `ReceiptHold.cash` once;
  from then on the operator can submit their claims, paying the fee and dust, but
  only when the balance grows by at least `minPush`, and only to the address the
  leaf commits to.

Full design, threat model and the answers to the bounty's open questions:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

Requires Node 20+ and a Chipnet Electrum connection.

```bash
npm install
npm run build:contracts        # compile both contracts → artifacts/
npm test                       # Merkle unit tests + real VM tests of every branch
npm run typecheck
```

The tests run the compiled contracts through libauth's BCH VM with CashScript's
`MockNetworkProvider`, including: a successful claim, a receipt claim, a replayed
proof, an inflated `earned`, a redirect of the payout, a drain attempt, the
rotation/timelock flow, `cancelRoot`, `deposit`, and the delegated push path with
its threshold.

## Chipnet demo (already executed — reproduce from scratch)

```bash
npm run faucet -- 2000000       # proof-of-work Chipnet faucet, 2M sats
npm run split -- 6 60000        # two txs with vout 0 outputs (CashTokens genesis rule)
npm run gen:csv -- 300 1        # 300 simulated contributors → demo/epochs/epoch-1.csv
npm run build:tree -- demo/epochs/epoch-1.csv 1
npm run mint                    # genesis: FLDCH stand-in + receipt/state NFT category
npm run deploy                  # fund the pool and publish the first root
npm run fund:users -- 3 15000   # give three demo users sats for their own claim fees
npm run claim -- 1              # user 1 claims 21,785 units + receipt NFT
npm run reject:double -- 1 <txid-of-that-claim>
npm run next-epoch              # epoch 2: carry claimed totals over from the chain
npm run build:tree -- demo/epochs/epoch-2.csv 2
npm run propose                 # publish the new root, claims pause
npm run reject:early            # activation attempt is rejected: BIP68 not satisfied
npm run activate:when-ready     # after the 2-block audit window
npm run claim -- 1              # user 1 claims the delta with their receipt NFT
npm run sync -- 2               # watcher: rebuild the root from chain history
npm run serve -- 8710           # proof server + /watch endpoint
npm run delegate -- 2 100       # user 2 opts in to operator push
npm run push -- 2 100           # operator submits user 2's claim, paying the fee
npm run status                  # pool state, balances, root check
npm run cost                    # push vs pull cost table from measured sizes
npm run depth                   # Merkle depth / VM limit table
```

The wallet lives at `/tmp/opencode/foldingcash_chipnet/wallet.json` (mode 600,
Chipnet only, mnemonic never printed). Demo users are derived from the same
disposable mnemonic at `m/44'/145'/0'/0/<n>` — a testnet convenience, documented
in [docs/DEMO.md](docs/DEMO.md).

## Cost headline

Measured, 1 sat/byte, BCH = $500, one epoch per month:

| users | push: operator fees | push: dust locked | pull: operator fees | pull: fees paid by claimants (all claim) |
|---|---|---|---|---|
| 100 | 25,600 sats ($0.13) | 100,000 sats | 2,348 sats ($0.01) | 254,100 sats ($1.27) |
| 1,000 | 256,000 sats ($1.28) | 1,000,000 sats | 2,348 sats ($0.01) | 2,541,000 sats ($12.71) |
| 10,000 | 2,560,000 sats ($12.80) | 10,000,000 sats | 2,348 sats ($0.01) | 25,410,000 sats ($127.05) |

The operator's cost becomes constant (~2,348 sats per epoch, no dust locked) and
the per-claim cost moves to the claimant, who can defer claims because roots are
cumulative. A claim is ~9.9× a push in bytes; claiming once a year beats twelve
pushes. Full methodology and sensitivity: [docs/COST.md](docs/COST.md).

## Merkle depth and VM limits

| DEPTH | slots | claim tx | ops/input | op cost / limit |
|---|---|---|---|---|
| 9 | 512 | 2543 B | 2700 | 299k / 794k |
| 14 | 16,384 | 2745 B | 3790 | 429k / 874k |
| 18 | 262,144 | 2909 B | 4662 | 538k / 940k |

Bytecode size is constant in `DEPTH` (the Merkle loop is shared through
`OP_DEFINE`); only the proof grows, 40 bytes per level. Reproduce: `npm run depth`.

## Repository layout

```
contracts/RewardPool.cash     the pool: claim, proposeRoot, activateRoot, cancelRoot, deposit
contracts/ReceiptHold.cash    optional receipt delegation for the operator push path
src/merkle.ts                 leaf/node encoding, fixed-depth tree, proofs, root update
src/pool.ts                   contract instantiation, state parsing, transaction builders
src/sync.ts                   claim-history replay (the watcher)
src/electrum.ts               minimal Electrum client for history + raw transactions
scripts/                      operator tooling, claim CLI, proof server, cost/depth analysis
test/merkle.test.ts           tree, proofs, mutation, padding, replay
test/vm.test.ts               every covenant branch and rejection in libauth's BCH VM
docs/ARCHITECTURE.md          design, threat model, open questions
docs/DEMO.md                  every Chipnet txid, command and rejection, with screenshots
docs/COST.md                  push vs pull, measured
docs/FINDINGS.md              what worked, what did not, limitations, v2 ideas
```

## Limitations (short version)

* A claim pays for the Merkle proof twice (both pool UTXOs run the covenant):
  2541 bytes instead of ~1300. See FINDINGS for the v2 fix.
* Claims pause during the audit window; that is what makes the timelock
  un-gameable.
* The operator still writes the `claimed` column at each rotation; a
  `cumulativeClaimed` that is too low is detectable (the watcher recomputes it)
  but not preventable on-chain.
* Not audited. Chipnet only. The demo derives many users from one test mnemonic.
* Chipnet nodes can lag the Electrum-reported tip, so a CSV-satisfying activation
  can be rejected for a few blocks — `npm run activate:when-ready` retries.

## License

MIT. See [LICENSE](LICENSE).
