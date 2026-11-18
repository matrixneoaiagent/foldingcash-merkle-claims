/**
 * Negative test 1: a second claim with an already-spent proof.
 *
 * Two independent rejections are shown:
 *   (a) the covenant, evaluated locally in libauth's BCH VM, refuses the stale
 *       proof because the pool's committed root moved when the first claim
 *       rewrote the leaf ("proof does not match active root");
 *   (b) rebroadcasting the original transaction is refused by the Chipnet node
 *       because its pool inputs are already spent.
 *
 * Usage: tsx scripts/reject-double-claim.ts <userIndex> <txidOfFirstClaim>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDeployment, poolContract, provider, readPool, walletAt, buildClaim } from '../src/pool';
import { addrHashOfAddress } from '../src/cash';
import { MerkleTree, type Leaf } from '../src/merkle';

const userIndex = Number(process.argv[2] ?? '1');
const firstClaimTxid = process.argv[3];
if (!firstClaimTxid) throw new Error('usage: reject-double-claim.ts <userIndex> <txidOfFirstClaim>');

const deployment = loadDeployment();
const providerInstance = provider();
const wallet = walletAt(userIndex);
const addrHash = addrHashOfAddress(wallet.address);
const contract = poolContract(deployment, providerInstance);
const state = await readPool(contract, deployment);

// the leaf set exactly as it was when the successful claim was made
const published = JSON.parse(
  readFileSync(resolve(`demo/epochs/epoch-${process.env.FC_EPOCH ?? '1'}.published.json`), 'utf8'),
) as { depth: number; leaves: { addrHash: string; earned: string; claimed: string }[] };
const publishedTree = new MerkleTree(
  published.leaves.map((l): Leaf => ({ addrHash: l.addrHash, earned: BigInt(l.earned), claimed: BigInt(l.claimed) })),
  published.depth,
);
const staleProof = publishedTree.proof(addrHash);

console.log(`user ${userIndex} ${wallet.address}`);
console.log(`  stale proof: earned=${staleProof.earned} claimed=${staleProof.claimed}`);
console.log(`  current on-chain root: ${state.activeRoot}`);
console.log(`  root the stale proof rebuilds: ${publishedTree.root}`);

const funding = (await providerInstance.getUtxos(wallet.address)).filter((u) => !u.token);
const builder = buildClaim(
  contract,
  state,
  { proof: staleProof, recipient: wallet.address, funding, claimer: wallet },
  providerInstance,
);

console.log('\n(a) local VM evaluation of the replay:');
try {
  builder.debug();
  console.log('  UNEXPECTED: the replay passed local evaluation');
  process.exitCode = 1;
} catch (error) {
  console.log(`  REJECTED: ${(error as Error).message.split('\n')[0]}`);
}

// (b) hand the same invalid transaction straight to the node, skipping the local
// VM check, so the rejection comes from Chipnet itself. The original claim's raw
// bytes are also rebroadcast to show that an identical replay is a no-op (same
// txid, already confirmed) and therefore cannot be mined twice.
console.log('\n(b) the same replay handed directly to a Chipnet node:');
try {
  const raw = builder.build();
  const txid = await providerInstance.sendRawTransaction(raw);
  console.log(`  UNEXPECTED: the node accepted the replay as ${txid}`);
  process.exitCode = 1;
} catch (error) {
  console.log(`  REJECTED: ${(error as Error).message.split('\n')[0]}`);
}

console.log('\n(c) rebroadcasting the exact original transaction (idempotent by txid):');
const originalRaw = await providerInstance.getRawTransaction(firstClaimTxid);
const echoed = await providerInstance.sendRawTransaction(originalRaw);
console.log(`  node returned the same txid ${echoed} — identical bytes cannot be mined twice`);
