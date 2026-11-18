/**
 * Operator: compute the next epoch.
 *
 * Real FoldingCash would recompute entitlements from the daily F@H stats file.
 * Here the "new folding" for each leaf is deterministic pseudo-random, and the
 * cumulative `claimed` column is rebuilt from the chain (published snapshot +
 * replayed claim history), so the next root is always consistent with what
 * users have actually withdrawn.
 *
 * Output: demo/epochs/epoch-<next>.csv (address,earned,claimed) and the matching
 * demo/tree.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDeployment, loadTree } from '../src/pool';
import { applyClaims, claimHistory } from '../src/sync';

const current = loadTree();
const next = current.epoch + 1;
const deployment = loadDeployment();

const published = JSON.parse(
  readFileSync(resolve(`demo/epochs/epoch-${current.epoch}.published.json`), 'utf8'),
) as { depth: number; epoch: number; root: string; leaves: { addrHash: string; address: string; earned: string; claimed: string }[] };

const records = await claimHistory(deployment);
const live = applyClaims(
  published.leaves.map((l) => ({ addrHash: l.addrHash, earned: BigInt(l.earned), claimed: BigInt(l.claimed) })),
  records,
  published.depth,
);

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0xe9_0c_40 + next);

const rows = ['address,earned,claimed'];
for (const leaf of published.leaves) {
  const liveLeaf = live.leaves.find((l) => l.addrHash === leaf.addrHash)!;
  // new folding since the last epoch: 0-12% more points
  const fresh = BigInt(Math.floor(Number(liveLeaf.earned) * rand() * 0.12));
  const earned = liveLeaf.earned + fresh;
  rows.push(`${leaf.address},${earned},${liveLeaf.claimed}`);
}

const csvPath = resolve(`demo/epochs/epoch-${next}.csv`);
writeFileSync(csvPath, `${rows.join('\n')}\n`);
console.log(`epoch ${next}: ${rows.length - 1} leaves, ${records.length} claim(s) carried over from chain`);
console.log(`wrote ${csvPath}`);
