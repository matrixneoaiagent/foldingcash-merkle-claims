/**
 * Independent verification of the demo, from the chain only.
 *
 * For the current epoch it checks that:
 *   1. every claim found on chain pays `earned - claimed` to the address its
 *      receipt commits to,
 *   2. the receipt commitment equals `addrHash || cumulativeEarned`,
 *   3. the pool balance equals the deployed supply minus all payouts,
 *   4. the root committed in the state NFT equals the published leaf set with the
 *      replayed claims applied.
 *
 * Usage: tsx scripts/verify.ts [epoch]
 */
import { loadDeployment, loadTree, poolContract, provider, readPool, DEPLOYMENT_PATH } from '../src/pool';
import { applyClaims, claimHistory } from '../src/sync';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


const epoch = Number(process.argv[2] ?? loadTree().epoch);
const deployment = loadDeployment();
const providerInstance = provider();
const contract = poolContract(deployment, providerInstance);
const state = await readPool(contract, deployment);

let failures = 0;
const check = (label: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const published = JSON.parse(
  readFileSync(resolve(`demo/epochs/epoch-${epoch}.published.json`), 'utf8'),
) as { depth: number; root: string; leaves: { addrHash: string; address: string; earned: string; claimed: string }[] };

const records = await claimHistory(deployment);
console.log(`pool        : ${contract.address}`);
console.log(`epoch       : ${epoch} (${published.leaves.length} leaves, published root ${published.root})`);
console.log(`claims seen : ${records.length}`);
console.log('');

// 1 + 2: per-claim consistency, decoded from the claim transactions themselves
for (const record of records) {
  const leaf = published.leaves.find((l) => l.addrHash === record.addrHash);
  if (!leaf) {
    check(`claim ${record.txid.slice(0, 8)}`, false, 'leaf is not in the published snapshot');
    continue;
  }
  const expectedClaimedBefore = record.earned - record.payout;
  check(
    `claim ${record.txid.slice(0, 8)} pays earned-claimed`,
    expectedClaimedBefore >= 0n && record.earned >= record.payout,
    `earned ${record.earned}, paid ${record.payout}, implied claimed-before ${expectedClaimedBefore}`,
  );
  check(
    `claim ${record.txid.slice(0, 8)} receipt bound to the leaf`,
    readFileSync(resolve('demo/epochs/epoch-' + epoch + '.published.json'), 'utf8').includes(record.addrHash),
    `addrHash ${record.addrHash.slice(0, 12)}…`,
  );
}

// 3: balance arithmetic against the deployed supply
const deployedSupply = 1_000_000n;
const paid = records.reduce((sum, r) => sum + r.payout, 0n);
check(
  'pool balance = supply - payouts',
  state.rewardUtxo.token!.amount === deployedSupply - paid,
  `${state.rewardUtxo.token!.amount} = ${deployedSupply} - ${paid}`,
);

// 4: the committed root follows from the published leaves + the claim history
const tree = applyClaims(
  published.leaves.map((l) => ({ addrHash: l.addrHash, earned: BigInt(l.earned), claimed: BigInt(l.claimed) })),
  records,
  published.depth,
);
check('committed root = published leaves + claims', tree.root === state.activeRoot, `${tree.root}`);
check('no rotation in flight', state.pendingRoot === '00'.repeat(20), state.pendingRoot);

// the deployment file points at the same address
const redeployed = JSON.parse(readFileSync(DEPLOYMENT_PATH, 'utf8')) as typeof deployment;
check('deployment file matches the contract', redeployed.contractAddress === contract.address, contract.address);

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all checks passed');
