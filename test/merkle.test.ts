import assert from 'node:assert/strict';
import test from 'node:test';
import { MerkleTree, computeRoot, leafHash, nodeHash, rootAfterClaim, verifyProof, EMPTY_LEAF_HASH, type Leaf } from '../src/merkle';

const leaves: Leaf[] = [
  { addrHash: '11'.repeat(20), earned: 1000n, claimed: 0n },
  { addrHash: '22'.repeat(20), earned: 2500n, claimed: 0n },
  { addrHash: '33'.repeat(20), earned: 42n, claimed: 0n },
  { addrHash: '44'.repeat(20), earned: 7n, claimed: 0n },
];

test('a single leaf is padded with EMPTY leaves up to the fixed depth', () => {
  const leaf = leafHash(leaves[0].addrHash, 1000n, 0n);
  const depth1 = new MerkleTree([leaves[0]], 1);
  assert.equal(depth1.root, nodeHash(leaf, EMPTY_LEAF_HASH).toString('hex'));
  const depth3 = new MerkleTree([leaves[0]], 3);
  const level1 = nodeHash(leaf, EMPTY_LEAF_HASH);
  const level2a = nodeHash(level1, nodeHash(EMPTY_LEAF_HASH, EMPTY_LEAF_HASH));
  const level2b = nodeHash(nodeHash(EMPTY_LEAF_HASH, EMPTY_LEAF_HASH), nodeHash(EMPTY_LEAF_HASH, EMPTY_LEAF_HASH));
  assert.equal(depth3.root, nodeHash(level2a, level2b).toString('hex'));
});

test('padding uses the empty leaf and every proof is DEPTH siblings', () => {
  const tree = new MerkleTree(leaves, 9);
  assert.equal(tree.layers[0].length, 512);
  assert.equal(tree.layers[0][5].toString('hex'), EMPTY_LEAF_HASH.toString('hex'));
  for (const leaf of leaves) {
    const proof = tree.proof(leaf.addrHash);
    assert.equal(proof.siblings.length, 9);
    assert.equal(verifyProof(proof, tree.root), true);
  }
});

test('proofs verify against a rebuilt tree and fail against another root', () => {
  const tree = new MerkleTree(leaves, 4);
  const proof = tree.proof(leaves[1].addrHash);
  assert.equal(computeRoot(leafHash(proof.addrHash, proof.earned, proof.claimed), proof.siblings, proof.path), tree.root);
  assert.equal(verifyProof(proof, '99'.repeat(20)), false);
});

test('tampering with the leaf value breaks the proof', () => {
  const tree = new MerkleTree(leaves, 4);
  const proof = tree.proof(leaves[1].addrHash);
  assert.equal(verifyProof({ ...proof, earned: 9999n }, tree.root), false);
  assert.equal(verifyProof({ ...proof, claimed: 1n }, tree.root), false);
});

test('claim mutation: root changes, replay is rejected, other leaves still verify', () => {
  const tree = new MerkleTree(leaves, 4);
  const proof = tree.proof(leaves[1].addrHash);
  const next = rootAfterClaim(proof);
  assert.notEqual(next, tree.root);

  // replaying the same proof against the new root must fail
  assert.equal(verifyProof(proof, next), false);

  // the mutated tree matches what the contract computes, and other leaves are untouched
  const claimedTree = tree.withClaimed(leaves[1].addrHash);
  assert.equal(claimedTree.root, next);
  for (const leaf of [leaves[0], leaves[2], leaves[3]]) {
    assert.equal(verifyProof(claimedTree.proof(leaf.addrHash), next), true);
  }
  // a second claim on the same leaf is now a zero-value claim
  const replay = claimedTree.proof(leaves[1].addrHash);
  assert.equal(replay.claimed, replay.earned);
  assert.equal(replay.earned - replay.claimed, 0n);
});

test('leaf ordering is normalised so the root is deterministic', () => {
  const shuffled = [leaves[3], leaves[1], leaves[0], leaves[2]];
  assert.equal(new MerkleTree(shuffled, 6).root, new MerkleTree(leaves, 6).root);
});

test('duplicate addresses and claimed > earned are rejected', () => {
  assert.throws(() => new MerkleTree([leaves[0], { ...leaves[0], earned: 5n }], 2), /duplicate/);
  assert.throws(() => new MerkleTree([{ ...leaves[0], claimed: 2000n }], 2), /claimed > earned/);
});
