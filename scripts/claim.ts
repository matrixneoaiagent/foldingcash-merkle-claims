/**
 * User-initiated claim: builds, locally evaluates, and broadcasts a claim for
 * one leaf of the currently active root, then updates the operator's offline
 * tree state with the new claimed total.
 *
 * The claimant pays the transaction fee and the two 1000-sat token dust outputs
 * (payout + receipt) out of their own wallet — that is the dust the operator
 * pays today when pushing.
 *
 * Usage: tsx scripts/claim.ts <userIndex> [--dry-run]
 */
import { loadDeployment, loadTree, poolContract, provider, readPool, saveTree, treeFromFile, walletAt, ZERO20 } from '../src/pool';
import { addrHashOfAddress } from '../src/cash';
import { buildClaim } from '../src/pool';
import { reportVmUsage, sendTx } from '../src/tx';

const userIndex = Number(process.argv[2] ?? '1');
const dryRun = process.argv.includes('--dry-run');

const deployment = loadDeployment();
const providerInstance = provider();
const wallet = walletAt(userIndex);
const addrHash = addrHashOfAddress(wallet.address);

const treeFile = loadTree();
const tree = treeFromFile(treeFile);
const contract = poolContract(deployment, providerInstance);
const state = await readPool(contract, deployment);

console.log(`claimant        : ${wallet.address} (derivation ${wallet.path})`);
console.log(`leaf addrHash   : ${addrHash}`);
console.log(`epoch           : ${treeFile.epoch} (${treeFile.leaves.length} leaves)`);
console.log(`on-chain root   : ${state.activeRoot}`);
console.log(`local tree root : ${tree.root}`);
if (state.activeRoot !== tree.root) {
  throw new Error(
    'local tree is out of sync with the chain — run `tsx scripts/sync.ts` to rebuild it from claim history',
  );
}
if (state.pendingRoot !== ZERO20) throw new Error('a root rotation is in flight: claims are paused');

const proof = tree.proof(addrHash);
const payout = proof.earned - proof.claimed;
if (payout <= 0n) throw new Error(`nothing to claim: already claimed ${proof.claimed}`);

const userUtxos = await providerInstance.getUtxos(wallet.address);
const u64 = (value: bigint): string => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf.toString('hex');
};
const receiptUtxo = userUtxos.find(
  (u) =>
    u.token?.category === deployment.receiptCategory &&
    u.token.nft?.capability === 'none' &&
    u.token.nft.commitment === `${addrHash}${u64(proof.claimed)}`,
);
if (proof.claimed > 0n && !receiptUtxo) {
  throw new Error(
    `claimed=${proof.claimed} but no matching receipt NFT is in ${wallet.address} — a receipt is required after the first claim`,
  );
}
const funding = userUtxos.filter((u) => !u.token);
if (funding.length === 0) throw new Error(`no BCH UTXOs at ${wallet.address}; fund the demo user first`);

const builder = buildClaim(
  contract,
  state,
  {
    proof,
    recipient: wallet.address,
    receiptUtxo,
    funding,
    claimer: wallet,
  },
  providerInstance,
);

console.log(`\nclaim: ${payout} reward units (cumulative earned ${proof.earned}, already claimed ${proof.claimed})`);
console.log(`  proof: ${proof.siblings.length} siblings, path bits ${proof.path}`);
reportVmUsage(builder, 'claim');
console.log(`  transaction size: ${builder.getTransactionSize()} bytes`);

if (dryRun) {
  builder.build();
  console.log('\n--dry-run: transaction built and evaluated locally, not broadcast');
  process.exit(0);
}

const txid = await sendTx(builder, `claim user ${userIndex} (${payout} units)`);

// operator bookkeeping (the watcher re-derives the same state from the chain)
const updated = tree.withClaimed(addrHash);
saveTree({
  ...treeFile,
  root: updated.root,
  leaves: treeFile.leaves.map((leaf) =>
    leaf.addrHash === addrHash ? { ...leaf, claimed: leaf.earned } : leaf,
  ),
});
console.log(`\nlocal tree root is now ${updated.root}`);
console.log(`receipt NFT minted to ${wallet.address} with commitment ${addrHash}${u64(proof.earned)}`);
console.log(txid);
