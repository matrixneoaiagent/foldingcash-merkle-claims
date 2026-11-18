# Submission draft (for DoraHacks / the sponsor)

Everything below is verified against the Chipnet run in [DEMO.md](DEMO.md).

## One-liner

A CashScript reward pool that pays FoldingCash contributors from a
Merkle-committed entitlement on proof, with per-user receipt NFTs, a
consensus-enforced root audit window, user-funded dust and an optional operator
push path — running end to end on Chipnet with 300 leaves.

## Short description (≈ 100 words)

FoldingCash pays contributors with a trusted monthly token push. This submission
replaces it with pull claims: the operator publishes a Merkle root of
`(addressHash, cumulativeEarned, cumulativeClaimed)`, and a CashScript pool pays
each user their own entitlement when they present a proof, at their own expense.
A per-user receipt NFT records the cumulative claimed total; the pool rewrites
the claimed leaf on every claim, so a replayed proof is impossible. Root updates
are two-phase and a new root cannot be activated before a BIP68 timelock
expires, giving watchers a hard audit window. The operator's cost per epoch
becomes constant, and an optional delegated push path keeps a minimum threshold.

## Long description

**What is delivered**

* `contracts/RewardPool.cash` — 457-byte covenant with five functions: `claim`
  (both first and repeat claims, Merkle proof verified against the on-chain
  root, payout restricted to the leaf address, receipt NFT minted/burned),
  `proposeRoot`, `activateRoot` (CSV timelock), `cancelRoot`, `deposit`.
  Reward tokens and the state NFT live in two UTXOs of the same address so the
  covenant can police both.
* `contracts/ReceiptHold.cash` — optional delegation so the operator can push a
  claim for a user who never claims, with the minimum push threshold enforced
  on-chain.
* Operator tooling: fixed-depth Merkle tree from a `(address, earned)` CSV,
  root publication, activation scheduling, an offline claim CLI, a watcher that
  replays claim history from the chain, and a proof-serving HTTP endpoint
  (`/proof/<address>`, `/watch`).
* Chipnet demo: 300-leaf tree, real token genesis, pool funding, a first claim
  (21,785 units, txid `dd7feac2…11236`), a demonstrably rejected double claim
  (both by the local VM and by a Chipnet node), a rejected early root activation
  (`BIP68 sequence lock not satisfied`), a successful activation after the audit
  window (`dffe5cfc…f44ab6`), and a receipt-based repeat claim
  (`27f475d8…e3bc`).
* Measurements: claim = 2541 bytes / 299k op cost of 794k; rotation = 1,174
  bytes; push = 256 bytes. Depth scaling to 262,144 leaves (2909 bytes/claim).
* Cost comparison: operator cost becomes O(1) per epoch (≈2,348 sats, no dust
  locked) instead of 2.56M sats + 0.1 BCH of dust at 10,000 users; claimants pay
  ≈2,541 sats per claim, of which 2,000 is their own recoverable dust.

**Answers to the open questions**

* *Epoch cadence*: weekly. Rotation costs ~2,300 sats and ~2.3 KiB of blockspace
  per epoch; cumulative roots let users skip epochs for free.
* *Scale*: `DEPTH` is compile-time; bytecode size is constant (the Merkle loop is
  shared via `OP_DEFINE`), the proof grows 40 bytes per level. 262k leaves still
  fits comfortably (538k/940k op cost).
* *Root authority*: single operator key here; the path to 2-of-3 is a multisig
  operator script hash, and the key can never move funds — only choose and time
  the active root.
* *Receipt commitment*: `addrHash(20) || cumulativeEarned(8 LE)`, immutable
  capability. Receipts are burned and re-minted on each claim.
* *Leaf contents*: `hash160(0x00 || addrHash || earned || claimed)`; a
  link-method byte can be added at the cost of one byte per leaf.
* *Link verification*: out of scope for this version; the leaf snapshot is
  published alongside the root, so per-leaf link evidence can be attached to the
  same document later.

**Why the receipt alone is not enough** — a stateless pool cannot distinguish "no
receipt exists" from "the receipt was not included", so a receipt-only design lets
a user claim twice by omitting it. The submission therefore also rewrites the
claimed leaf into the committed root, which makes replay cryptographically
impossible, and keeps the receipt as the portable cross-epoch record and the
delegation object.

**What is missing** — F@H data ingestion (the CSV generator is deterministic
pseudo-random), a wallet UI, a scheduled auto-claim daemon, multisig operator
keys, and an external audit. See FINDINGS.md.

## Links

* Repository: https://github.com/matrixneoaiagent/foldingcash-merkle-claims
* Architecture: `docs/ARCHITECTURE.md` · Demo transcript: `docs/DEMO.md` ·
  Costs: `docs/COST.md` · Findings: `docs/FINDINGS.md`
* Pool (Chipnet): `bchtest:pdxtzth4sqfkkt9pr6gkctaz5xatgwwlt5utge2jgkyhjp9nw3spcwhq6uax2`

## Tx table for the submission form

| step | txid |
|---|---|
| FLDCH stand-in genesis (1,000,000 units) | `5e8c12db8aea53ed81e644f72a11fe2e390f9271a78be948126a375a5fa3492e` |
| receipt/state NFT genesis | `4390beeecf120ecc5b3a70ce850ed1e63f74a0b258be1d6b4f0e30e271d08a39` |
| deploy pool + epoch-1 root | `57bcc06da87be96eab1d3489aad476afd3b59639298e723a4b9dc97fde937b4d` |
| claim (first, 21,785 units) | `dd7feac267d5983935b7fd8610eb97d8af44ac203eeac24bb3ecc7e42ff11236` |
| propose epoch-2 root | `2021ae7dd911d1cd10adfabe750f7201f0055d9cc0ec073d73ebb1e0c4791680` |
| activate epoch-2 root | `dffe5cfc895bfec1aa460148ad1cefc8f7427f80a8776706ab3bc39db9f44ab6` |
| claim (with receipt, 1,903 units) | `27f475d87b3339eff258dc1a1cede309368ce252126befba46d96b5ed243e3bc` |
| user 2 claim | `69650499b8c89b9814989b43e0561dd24cd11b9c90dd58f457f1369f94178f78` |
| user 2 delegates receipt to ReceiptHold | `11104ccfdc24cf0e8750ba2567afec23f956ffb26228b70f21dea22ca041f589` |
| propose epoch-3 root | `4338366ec224fe565f0801064c966de537d6051646300a3d54bc58e437550bff` |
| activate epoch-3 root | `fb5afb88a7851fe62cc88c27c859f8a74f08afecc92ebfa1ebf0afbc4cae054d` |
| operator push (delegated receipt) | `54e295b52a4e78cfb03277eb22641a3ef7c7e9c342612a1c1c7828b2b5cc9b82` |
| user 3 claim | `cc1fbadd2630c90f4c1606f409634ddf0461e74f3012e06afd0cf6aba444564c` |

All on Chipnet, viewable at `https://chipnet.imaginary.cash/tx/<txid>`.
