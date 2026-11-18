/**
 * Merkle depth / VM limit analysis.
 *
 * Compiles the pool at several fixed depths and measures, for each:
 *   - redeem script size (bytes)
 *   - a real claim transaction's byte size and fee at 1 sat/B
 *   - VM operation cost and hash digest iterations for the claim, against the
 *     per-input limits the node enforces
 *
 * Usage: tsx scripts/depth-analysis.ts
 */
import { compileString } from 'cashc';
import { Contract, MockNetworkProvider, TransactionBuilder } from 'cashscript';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MerkleTree, hash160, rootAfterClaim, type Leaf } from '../src/merkle';
import { addrHashOfAddress, lockingBytecodeOf } from '../src/cash';
import { toContractCategory, walletFromMnemonic } from '../src/wallet';
import { encodeState } from '../src/pool';

const REWARD = 'aa'.repeat(32);
const RECEIPT = 'bb'.repeat(32);
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const operator = walletFromMnemonic(MNEMONIC, 0);
const user = walletFromMnemonic(MNEMONIC, 1000); // first leaf owner
const base = readFileSync(resolve('contracts/RewardPool.cash'), 'utf8');
const u64 = (value: bigint): string => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf.toString('hex');
};

const rows: string[] = [];
rows.push('| DEPTH | leaf slots | redeem script | claim tx | claim fee @1 sat/B | ops/input | op cost / limit | hash iterations / limit | claim fee as % of a 25,000-unit reward |');
rows.push('|---|---|---|---|---|---|---|---|---|');

for (const depth of [6, 8, 9, 10, 12, 14, 16, 18]) {
  const source = base.replace(/int constant DEPTH = \d+;/, `int constant DEPTH = ${depth};`);
  const artifact = compileString(source);

  const provider = new MockNetworkProvider();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contract: any = new Contract(
    artifact as never,
    [toContractCategory(REWARD), toContractCategory(RECEIPT), operator.publicKey, 2n] as never,
    { provider } as never,
  );

  // a tree with a realistic fill ratio (about 58% of the slots are real leaves).
  // Only the first leaf needs a real address; the rest are synthetic digests, so
  // this stays fast even at depth 16.
  const leafCount = Math.max(2, Math.floor(2 ** depth * 0.58));
  const leaves: Leaf[] = [
    { addrHash: addrHashOfAddress(walletFromMnemonic(MNEMONIC, 1000).address), earned: 5000n, claimed: 0n },
  ];
  for (let i = 1; i < leafCount; i += 1) {
    leaves.push({ addrHash: hash160(Buffer.from(`leaf-${depth}-${i}`)).toString('hex'), earned: BigInt(1000 + i * 37), claimed: 0n });
  }
  const tree = new MerkleTree(leaves, depth);
  const proof = tree.proof(leaves[0].addrHash);

  const rewardUtxo = provider.addUtxo(contract.tokenAddress, {
    txid: '02'.repeat(32),
    vout: 0,
    satoshis: 1_000n,
    token: { category: REWARD, amount: 10_000_000n },
  });
  const stateUtxo = provider.addUtxo(contract.tokenAddress, {
    txid: '03'.repeat(32),
    vout: 1,
    satoshis: 1_000n,
    token: { category: RECEIPT, amount: 0n, nft: { capability: 'minting', commitment: encodeState(tree.root) } },
  });
  const funding = provider.addUtxo(Buffer.from(lockingBytecodeOf(user.address)).toString('hex'), {
    txid: '04'.repeat(32),
    vout: 0,
    satoshis: 50_000n,
  });

  const proofBytes = Buffer.concat(proof.siblings.map((s) => Buffer.from(s, 'hex')));
  const unlock = contract.unlock.claim(
    Buffer.from(proof.addrHash, 'hex'),
    proof.earned,
    proof.claimed,
    proofBytes,
    BigInt(proof.path),
    false,
  );
  const payout = proof.earned - proof.claimed;
  const builder = new TransactionBuilder({ provider });
  builder.addInput(rewardUtxo, unlock);
  builder.addInput(stateUtxo, unlock);
  builder.addInput(funding, user.unlocker);
  builder.addOutput({ to: user.address, amount: 1000n, token: { category: REWARD, amount: payout } });
  builder.addOutput({ to: contract.tokenAddress, amount: 1000n, token: { category: REWARD, amount: 10_000_000n - payout } });
  builder.addOutput({
    to: contract.tokenAddress,
    amount: 1000n,
    token: {
      category: RECEIPT,
      amount: 0n,
      nft: { capability: 'minting', commitment: encodeState(rootAfterClaim(proof)) },
    },
  });
  builder.addOutput({
    to: user.address,
    amount: 1000n,
    token: {
      category: RECEIPT,
      amount: 0n,
      nft: { capability: 'none', commitment: `${proof.addrHash}${u64(proof.earned)}` },
    },
  });
  builder.addBchChangeOutputIfNeeded({ to: user.address, feeRate: 1 });
  const size = Number(builder.getTransactionSize());
  const usage = builder.getVmResourceUsage(false)[0] as Record<string, number | bigint>;

  rows.push(
    `| ${depth} | ${2 ** depth} | ${contract.bytesize} B | ${size} B | ${size} sats | ${String(usage.evaluatedInstructionCount)} | ${String(usage.operationCost)} / ${String(usage.maximumOperationCost)} | ${String(usage.hashDigestIterations)} / ${String(usage.maximumHashDigestIterations)} | ${((size / 25_000) * 100).toFixed(2)}% |`,
  );
  console.log(`depth ${depth}: script ${contract.bytesize} B, claim ${size} B, ops ${usage.evaluatedInstructionCount}`);
}

writeFileSync(mkdtempSync(join(tmpdir(), 'depth-')).concat('/README.md'), '');
console.log();
console.log(rows.join('\n'));
