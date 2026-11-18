/**
 * Builds the fixed-depth Merkle tree from a (address, earned) CSV and writes
 * demo/tree.json, which is the operator's offline state: leaves, cumulative
 * claimed totals, and the root that goes on-chain.
 *
 * Usage: tsx scripts/build-tree.ts [csv] [epoch]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MerkleTree, type Leaf } from '../src/merkle';
import { addrHashOfAddress } from '../src/cash';
import { DEPTH, saveTree, type TreeFile } from '../src/pool';

const csvPath = resolve(process.argv[2] ?? 'demo/epochs/epoch-1.csv');
const epoch = Number(process.argv[3] ?? '1');

export type CsvRow = { address: string; earned: bigint; claimed: bigint };

export function parseCsv(text: string): CsvRow[] {
  const rows: CsvRow[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('address,')) continue;
    const [address, earned, claimed] = trimmed.split(',');
    if (!address || !earned) throw new Error(`bad csv row: ${line}`);
    rows.push({
      address,
      earned: BigInt(earned),
      claimed: BigInt(claimed ?? '0'),
    });
  }
  return rows;
}

const rows = parseCsv(readFileSync(csvPath, 'utf8'));
const leaves: Leaf[] = rows.map((row) => ({
  addrHash: addrHashOfAddress(row.address),
  earned: row.earned,
  claimed: row.claimed,
}));

const tree = new MerkleTree(leaves, DEPTH);
if (leaves.length > 2 ** DEPTH) throw new Error('too many leaves for the compiled DEPTH');

const file: TreeFile = {
  depth: DEPTH,
  epoch,
  root: tree.root,
  leaves: rows
    .map((row, i) => ({
      addrHash: leaves[i].addrHash,
      address: row.address,
      earned: row.earned.toString(),
      claimed: row.claimed.toString(),
    }))
    .sort((a, b) => (a.addrHash < b.addrHash ? -1 : 1)),
};

// sanity: every leaf must verify against the root we are about to publish
for (const leaf of file.leaves) {
  const proof = tree.proof(leaf.addrHash);
  if (proof.earned !== BigInt(leaf.earned)) throw new Error(`proof/leaf mismatch for ${leaf.address}`);
}

saveTree(file);
// immutable snapshot of exactly what was published: the watcher rebuilds the
// live root from this snapshot + the claim history it replays from the chain.
writeFileSync(
  resolve(`demo/epochs/epoch-${epoch}.published.json`),
  `${JSON.stringify({ depth: DEPTH, epoch, root: tree.root, leaves: file.leaves }, null, 2)}\n`,
);
console.log(`epoch ${epoch}: ${file.leaves.length} leaves, depth ${DEPTH}, ${2 ** DEPTH} slots`);
console.log(`root: ${tree.root}`);
console.log(`tree written to demo/tree.json`);
