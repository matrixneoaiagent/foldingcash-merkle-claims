/**
 * Rebuilds the operator's tree state from the chain (this is also the watcher).
 *
 * Every claim transaction has a fixed shape, so a claim can be recognised and
 * decoded from its outputs alone — no trust in the operator's database:
 *
 *   out 0: reward tokens, amount = payout, paid to hash160(leaf address)
 *   out 1: reward tokens back to the pool
 *   out 2: state NFT with the new root
 *   out 3: immutable receipt NFT, commitment = addrHash(20) || cumulativeEarned(8)
 *   out 4: claimant change
 *
 * From out 0 and out 3 we recover (addrHash, earned, claimedBefore) and replay
 * the same leaf mutation the covenant applies. The recomputed root can then be
 * compared with the root actually committed in the pool's state NFT.
 */
import { binToHex } from '@bitauth/libauth';
import { MerkleTree, type Leaf } from './merkle';
import { type Deployment } from './pool';
import { decodedTransaction, electrumClient, historyForAddress } from './electrum';

export type ClaimRecord = {
  txid: string;
  addrHash: string;
  earned: bigint;
  payout: bigint;
  address: string;
};

const u64FromLe = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i]);
  return value;
};

export async function claimHistory(deployment: Deployment): Promise<ClaimRecord[]> {
  const client = electrumClient();
  await client.connect();
  try {
    const history = await historyForAddress(client, deployment.contractAddress);
    const records: ClaimRecord[] = [];
    for (const entry of history.sort((a, b) => a.height - b.height)) {
      const tx = await decodedTransaction(client, entry.tx_hash);
      const outputs = tx.outputs as Array<{ lockingBytecode: Uint8Array; token?: { category: Uint8Array; amount: bigint; nft?: { capability: string; commitment: Uint8Array } } }>;
      if (outputs.length !== 5) continue;
      const receipt = outputs[3];
      if (!receipt.token?.nft || receipt.token.nft.capability !== 'none') continue;
      if (binToHex(receipt.token.category) !== deployment.receiptCategory) continue;
      const commitment = receipt.token.nft.commitment;
      if (commitment.length !== 28) continue;
      const payout = outputs[0].token?.amount ?? 0n;
      const earned = u64FromLe(commitment.slice(20));
      records.push({
        txid: entry.tx_hash,
        addrHash: binToHex(commitment.slice(0, 20)),
        earned,
        payout,
        address: binToHex(outputs[0].lockingBytecode),
      });
    }
    return records;
  } finally {
    await client.disconnect();
  }
}

export function applyClaims(published: Leaf[], records: ClaimRecord[], depth: number): MerkleTree {
  const leaves = published.map((leaf) => ({ ...leaf }));
  for (const record of records) {
    const index = leaves.findIndex((leaf) => leaf.addrHash === record.addrHash);
    if (index === -1) throw new Error(`claim ${record.txid} references an unknown leaf`);
    // Receipt commitments are cumulative, so the claimed total is the maximum
    // total observed for that leaf. This keeps the replay independent of the
    // order in which the node returns transactions.
    const claimed = record.earned > leaves[index].claimed ? record.earned : leaves[index].claimed;
    leaves[index] = { ...leaves[index], claimed };
  }
  return new MerkleTree(leaves, depth);
}

/** Compares the root the chain says is active with a locally rebuilt one. */
export function reversedHex(displayHex: string): string {
  return Buffer.from(displayHex, 'hex').reverse().toString('hex');
}
