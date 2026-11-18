/**
 * Watcher / proof-server sync.
 *
 * Rebuilds the live tree from:
 *   - the published leaf snapshot of the current epoch, and
 *   - every claim replayed from the pool address' on-chain history,
 * then compares the recomputed root with the root committed in the pool's
 * state NFT. If they differ, the operator published something it cannot
 * justify from the chain and the run fails loudly.
 *
 * Usage: tsx scripts/sync.ts [epoch]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDeployment, loadTree, provider, readPool, poolContract, saveTree } from '../src/pool';
import { applyClaims, claimHistory } from '../src/sync';

const epoch = Number(process.argv[2] ?? process.env.FC_EPOCH ?? loadTree().epoch);
const deployment = loadDeployment();
const publishedPath = resolve(`demo/epochs/epoch-${epoch}.published.json`);
const published = JSON.parse(readFileSync(publishedPath, 'utf8')) as {
  depth: number;
  epoch: number;
  root: string;
  leaves: { addrHash: string; address: string; earned: string; claimed: string }[];
};

console.log(`epoch ${epoch}: replaying claims from ${deployment.contractAddress}`);
const records = await claimHistory(deployment);
console.log(`  claims found on chain: ${records.length}`);
const tree = applyClaims(
  published.leaves.map((l) => ({ addrHash: l.addrHash, earned: BigInt(l.earned), claimed: BigInt(l.claimed) })),
  records,
  published.depth,
);

const contract = poolContract(deployment, provider());
const state = await readPool(contract, deployment);
console.log(`  published root        : ${published.root}`);
console.log(`  recomputed root       : ${tree.root}`);
console.log(`  on-chain active root  : ${state.activeRoot}`);
if (tree.root !== state.activeRoot) {
  throw new Error('MISMATCH: the on-chain root cannot be rebuilt from the published leaves + claim history');
}
console.log('  MATCH: the committed root is fully explained by the published leaves and the claim history');

saveTree({
  depth: published.depth,
  epoch,
  root: tree.root,
  leaves: published.leaves.map((leaf) => {
    const record = records.find((r) => r.addrHash === leaf.addrHash);
    return record ? { ...leaf, claimed: record.earned.toString() } : leaf;
  }),
});
writeFileSync(
  resolve('demo/last-sync.json'),
  `${JSON.stringify(
    { at: new Date().toISOString(), epoch, root: tree.root, claims: records.map((r) => ({ ...r, earned: r.earned.toString(), payout: r.payout.toString() })) },
    null,
    2,
  )}\n`,
);
console.log('  local tree state refreshed (demo/tree.json)');
