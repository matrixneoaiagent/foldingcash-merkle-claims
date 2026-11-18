import { createHash } from 'node:crypto';

/**
 * Fixed-depth Merkle tree used by the FoldingCash reward pool.
 *
 * The on-chain verifier (contracts/RewardPool.cash) walks exactly DEPTH levels
 * with 20-byte hash160() nodes, so every proof is DEPTH * 20 bytes and every
 * level costs one hash160 plus one byte-slice. Leaves are padded to 2^DEPTH
 * slots with the EMPTY leaf so the tree is always a perfect binary tree.
 *
 * Leaf preimage:  0x00 || addressHash(20) || cumulativeEarned(8 LE) || cumulativeClaimed(8 LE)
 * Node preimage:  0x01 || left(20) || right(20)
 * Both are hash160()-ed. The preimages differ in length (37 vs 41 bytes), and
 * the leading tag byte keeps leaves and inner nodes in separate domains.
 */

export const HASH_BYTES = 20;
export const PROOF_BYTES = HASH_BYTES;

export type Leaf = {
  /** hash160 of the recipient's locking bytecode, 40 hex chars */
  addrHash: string;
  /** cumulative tokens earned up to and including this epoch */
  earned: bigint;
  /** cumulative tokens already claimed by this leaf */
  claimed: bigint;
};

export type Proof = {
  addrHash: string;
  earned: bigint;
  claimed: bigint;
  /** DEPTH sibling hashes, leaf level first, 40 hex chars each */
  siblings: string[];
  /** bit i set => the node is the right child at level i */
  path: number;
};

const toBuf = (hex: string): Buffer => Buffer.from(hex.replace(/^0x/, ''), 'hex');
const toHex = (buf: Uint8Array): string => Buffer.from(buf).toString('hex');

export function hash160(data: Uint8Array): Buffer {
  const sha = createHash('sha256').update(data).digest();
  return createHash('ripemd160').update(sha).digest();
}

export function encodeU64(value: bigint): Buffer {
  if (value < 0n) throw new Error('negative values are not allowed');
  if (value >= 1n << 55n) {
    // Script numbers are sign-magnitude; bit 63 is the sign bit, so 8-byte
    // padding is only lossless below 2^55.
    throw new Error(`value ${value} does not fit in 8-byte script-number padding`);
  }
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

export function leafPreimage(addrHash: string, earned: bigint, claimed: bigint): Buffer {
  const addr = toBuf(addrHash);
  if (addr.length !== HASH_BYTES) throw new Error(`addrHash must be ${HASH_BYTES} bytes`);
  return Buffer.concat([Buffer.from([0x00]), addr, encodeU64(earned), encodeU64(claimed)]);
}

export function leafHash(addrHash: string, earned: bigint, claimed: bigint): Buffer {
  return hash160(leafPreimage(addrHash, earned, claimed));
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return hash160(Buffer.concat([Buffer.from([0x01]), left, right]));
}

export const EMPTY_LEAF_HASH: Buffer = leafHash('00'.repeat(HASH_BYTES), 0n, 0n);

export class MerkleTree {
  readonly depth: number;
  readonly leaves: Leaf[];
  /** layers[0] has 2^depth leaf hashes, layers[depth] has the root */
  readonly layers: Buffer[][];

  constructor(leaves: Leaf[], depth: number) {
    if (depth < 1 || depth > 20) throw new Error('depth must be between 1 and 20');
    if (leaves.length > 2 ** depth) {
      throw new Error(`${leaves.length} leaves do not fit into 2^${depth} = ${2 ** depth} slots`);
    }
    this.depth = depth;
    this.leaves = normalise(leaves);
    this.layers = buildLayers(this.leaves, depth);
  }

  static fromLeaves(leaves: Leaf[], depth: number): MerkleTree {
    return new MerkleTree(normalise(leaves), depth);
  }

  get root(): string {
    return toHex(this.layers[this.depth][0]);
  }

  get rootBytes(): Buffer {
    return this.layers[this.depth][0];
  }

  get size(): number {
    return this.leaves.length;
  }

  indexOf(addrHash: string): number {
    const wanted = addrHash.replace(/^0x/, '').toLowerCase();
    const index = this.leaves.findIndex((leaf) => leaf.addrHash === wanted);
    if (index === -1) throw new Error(`address hash ${wanted} is not in the tree`);
    return index;
  }

  proof(addrHash: string): Proof {
    const index = this.indexOf(addrHash);
    const leaf = this.leaves[index];
    const siblings: string[] = [];
    let path = 0;
    let position = index;
    for (let level = 0; level < this.depth; level += 1) {
      const siblingIndex = position ^ 1;
      siblings.push(toHex(this.layers[level][siblingIndex]));
      if (position % 2 === 1) path |= 1 << level;
      position = Math.floor(position / 2);
    }
    return { addrHash: leaf.addrHash, earned: leaf.earned, claimed: leaf.claimed, siblings, path };
  }

  /** Returns the leaf set with `addrHash` marked as fully claimed (and rebuilt). */
  withClaimed(addrHash: string): MerkleTree {
    const index = this.indexOf(addrHash);
    const leaves = this.leaves.map((leaf, i) =>
      i === index ? { ...leaf, claimed: leaf.earned } : leaf,
    );
    return new MerkleTree(leaves, this.depth);
  }
}

function normalise(leaves: Leaf[]): Leaf[] {
  const seen = new Set<string>();
  const sorted = [...leaves].sort((a, b) => (a.addrHash < b.addrHash ? -1 : a.addrHash > b.addrHash ? 1 : 0));
  for (const leaf of sorted) {
    if (leaf.addrHash.length !== HASH_BYTES * 2) throw new Error(`bad addrHash ${leaf.addrHash}`);
    if (leaf.claimed > leaf.earned) throw new Error(`claimed > earned for ${leaf.addrHash}`);
    if (seen.has(leaf.addrHash)) throw new Error(`duplicate addrHash ${leaf.addrHash}`);
    seen.add(leaf.addrHash);
  }
  return sorted;
}

function buildLayers(leaves: Leaf[], depth: number): Buffer[][] {
  const width = 2 ** depth;
  const layer0: Buffer[] = leaves.map((leaf) => leafHash(leaf.addrHash, leaf.earned, leaf.claimed));
  while (layer0.length < width) layer0.push(EMPTY_LEAF_HASH);
  const layers: Buffer[][] = [layer0];
  for (let level = 0; level < depth; level += 1) {
    const previous = layers[level];
    const next: Buffer[] = [];
    for (let i = 0; i < previous.length; i += 2) next.push(nodeHash(previous[i], previous[i + 1]));
    layers.push(next);
  }
  return layers;
}

/** Recomputes a root from a leaf hash, proof and path (mirrors the contract). */
export function computeRoot(leaf: Uint8Array, siblings: string[], path: number): string {
  let node: Uint8Array = Buffer.from(leaf);
  siblings.forEach((sibling, level) => {
    const siblingBuf = toBuf(sibling);
    const nodeIsRight = Math.floor(path / 2 ** level) % 2 === 1;
    node = nodeIsRight ? nodeHash(siblingBuf, node) : nodeHash(node, siblingBuf);
  });
  return toHex(node);
}

/** Checks a proof the same way the contract does (old leaf -> root). */
export function verifyProof(proof: Proof, root: string): boolean {
  const leaf = leafHash(proof.addrHash, proof.earned, proof.claimed);
  return computeRoot(leaf, proof.siblings, proof.path) === root;
}

/** Root after this claim has been applied (leaf flipped to fully claimed). */
export function rootAfterClaim(proof: Proof): string {
  const leaf = leafHash(proof.addrHash, proof.earned, proof.earned);
  return computeRoot(leaf, proof.siblings, proof.path);
}

export function proofToBytes(proof: Proof): Uint8Array {
  if (proof.siblings.length !== Number(proof.siblings.length)) throw new Error('bad proof');
  return Buffer.concat(proof.siblings.map(toBuf));
}

export function hexToBytes(hex: string): Uint8Array {
  return toBuf(hex);
}

export function bytesToHex(bytes: Uint8Array): string {
  return toHex(bytes);
}
