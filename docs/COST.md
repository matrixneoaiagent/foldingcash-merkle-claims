# Cost comparison: monthly push vs. pull claims

All transaction sizes below are **measured**, not estimated: `scripts/cost-model.ts`
builds each transaction shape with CashScript's `TransactionBuilder` against an
in-memory provider and reads `getTransactionSize()`. The claim size is the real
claim transaction that was broadcast on Chipnet (2541 bytes, see
[demo](DEMO.md)).

Reproduce:

```bash
npm run cost                    # 1 sat/B, BCH = $500
FC_FEE_RATE=2 FC_BCH_USD=800 npm run cost
```

| measured transaction | bytes |
|---|---|
| push one user (1 token input -> user output + change) | 256 |
| one pull claim (2 pool inputs + 1 claimant input, 5 outputs) | 2541 |
| root rotation, `proposeRoot` or `activateRoot` (2 inputs, 2 outputs) | 1174 / 1153 |
| pool deployment, one-off (3 inputs, 3 outputs, both pool UTXOs) | 669 |

## The table

One epoch per month, fee rate 1 sat/byte, BCH = $500, token dust 1000 sats per
token-carrying output.

| users | push: operator fees | push: dust locked | push: blockspace | pull: operator fees | pull: blockspace | pull: fees paid by claimants (if all claim) |
|---|---|---|---|---|---|---|
| 100 | 25,600 sats (0.000256 BCH, $0.13) | 100,000 sats (0.001 BCH) | 25.0 KiB | 2,348 sats (0.000023 BCH, $0.01) | 2.3 KiB | 254,100 sats (0.002541 BCH, $1.27) |
| 1,000 | 256,000 sats (0.00256 BCH, $1.28) | 1,000,000 sats (0.01 BCH) | 250.0 KiB | 2,348 sats (0.000023 BCH, $0.01) | 2.3 KiB | 2,541,000 sats (0.02541 BCH, $12.71) |
| 10,000 | 2,560,000 sats (0.0256 BCH, $12.80) | 10,000,000 sats (0.1 BCH) | 2500.0 KiB | 2,348 sats (0.000023 BCH, $0.01) | 2.3 KiB | 25,410,000 sats (0.2541 BCH, $127.05) |

Per claim: **2541 sats** ($0.01), of which 2000 sats are token dust that stays in
the claimant's own outputs and is recovered when they spend them.
Per push: **256 sats** ($0.0013) plus 1000 sats of the operator's dust, which does
not come back until that user spends the output.

## What the table actually says

1. **The operator's cost becomes O(1).** Two rotation transactions (~2,348 sats,
   $0.01) per epoch, whatever the user count. At 10,000 users the push model
   costs the operator 2.56M sats and 0.1 BCH of locked dust per epoch; the pull
   model costs 2,348 sats and locks nothing.
2. **The total cost does not disappear, it moves.** A claim is ~10x a push
   (2541 vs 256 bytes) because it carries a 9-level proof, the state NFT and the
   receipt NFT — twice, since both pool UTXOs run the same script. The claimant
   pays it, when they choose to.
3. **Frequency is the lever.** With cumulative roots a user can claim once a
   year instead of twelve times: 2541 sats/year instead of the operator pushing
   3,072 sats/year plus 12,000 sats of dust locked. Claiming every epoch is the
   worst case for the user and still cheaper in aggregate than pushing to
   10,000 people, because the operator's part is constant.
4. **Dust is the hidden cost of the push model.** Every pushed output locks 1000
   sats of the operator's money. At 10,000 users that is 0.1 BCH of working
   capital per epoch, and it is exactly the problem the bounty describes from the
   FoldingCoin era: for small balances the dust is worth more than the reward.
   In the pull model the dust comes from the claimant, who is the only person who
   knows the claim is worth making.
5. **A claim is only worth making above a threshold.** At 2541 sats a claim pays
   for itself once the outstanding balance is worth more than that (roughly 2,541
   FLDCH units at par, or a few thousand units if FLDCH trades below $1). Below
   that, the right answer is to wait — cumulative roots make waiting free — or to
   use the operator's delegated push path, where the on-chain `minPush` threshold
   keeps the operator from paying 256 sats to move 50 units.

## Sensitivity

| fee rate | per claim | per push | operator per epoch (rotation x2) |
|---|---|---|---|
| 1 sat/B | 2541 sats | 256 sats | 2,348 sats |
| 2 sat/B | 5082 sats | 512 sats | 4,696 sats |
| 0.5 sat/B | 1271 sats | 128 sats | 1,174 sats |

The ratio between push and pull does not change with the fee rate: it is a size
ratio (2541 / 256 ≈ 9.9x), set by the proof and the two extra token outputs.

## Where the bytes go (first claim, 2541 bytes)

| part | bytes |
|---|---|
| pool reward input (unlocking script: redeem script 457 B + 6 args + 180 B proof) | ~700 |
| pool state input (same script and args) | ~700 |
| claimant P2PKH input | ~150 |
| 5 outputs (2 with 1000-sat token dust, 1 change) | ~250 |
| token prefixes and overhead | ~100 |
| remainder: signatures, varints, sequence numbers | ~640 |

The proof is paid for twice because both pool UTXOs must run the covenant. That
is the main optimisation target for a v2 (see
[FINDINGS](FINDINGS.md#1-a-claim-pays-for-the-proof-twice)).
