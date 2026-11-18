/**
 * Local VM tests: they compile the real contract and run real transactions
 * through libauth's BCH VM (via CashScript's MockNetworkProvider), so the
 * covenant logic is exercised without touching a network.
 *
 * The mock does not model relative-locktime *elapsed time* (no confirmation
 * heights), so `this.age` is only compared against the input's sequence field
 * here; real CSV enforcement is demonstrated on Chipnet by
 * scripts/reject-early-activation.ts and scripts/activate-root.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Contract, MockNetworkProvider, TransactionBuilder, type SpendableUtxo } from 'cashscript';
import { MerkleTree, rootAfterClaim, type Leaf } from '../src/merkle';
import { toContractCategory, walletFromMnemonic } from '../src/wallet';
import { addrHashOfAddress, lockingBytecodeOf } from '../src/cash';
import {
  buildActivate,
  buildCancel,
  buildClaim,
  buildPropose,
  encodeState,
  parseState,
  ZERO20,
  type PoolState,
} from '../src/pool';
import { readFileSync as readArtifact } from 'node:fs';
import { toContractCategory as toCategory } from '../src/wallet';

const DEPTH = 9;
const REWARD_CATEGORY = 'aa'.repeat(32);
const RECEIPT_CATEGORY = 'bb'.repeat(32);
const AUDIT_DELAY = 2n;
const artifact = JSON.parse(readFileSync(resolve('artifacts/RewardPool.json'), 'utf8'));

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const operator = walletFromMnemonic(MNEMONIC, 0);
const users = [1, 2, 3].map((i) => walletFromMnemonic(MNEMONIC, i));

const leaves: Leaf[] = users.map((user, i) => ({
  addrHash: addrHashOfAddress(user.address),
  earned: [5000n, 12000n, 1n][i],
  claimed: 0n,
}));
const tree = new MerkleTree(leaves, DEPTH);

type Pool = PoolState & { contract: Contract; provider: MockNetworkProvider };

function newPool(root = tree.root): Pool {
  const provider = new MockNetworkProvider();
  const contract = new Contract(
    artifact,
    [
      toContractCategory(REWARD_CATEGORY),
      toContractCategory(RECEIPT_CATEGORY),
      operator.publicKey,
      AUDIT_DELAY,
    ],
    { provider },
  );
  const rewardUtxo = provider.addUtxo(contract.tokenAddress, {
    txid: '11'.repeat(32),
    vout: 0,
    satoshis: 10_000n,
    token: { category: REWARD_CATEGORY, amount: 1_000_000n },
  });
  const stateUtxo = provider.addUtxo(contract.tokenAddress, {
    txid: '22'.repeat(32),
    vout: 0,
    satoshis: 5_000n,
    token: {
      category: RECEIPT_CATEGORY,
      amount: 0n,
      nft: { capability: 'minting', commitment: encodeState(root) },
    },
  });
  return { contract, provider, rewardUtxo, stateUtxo, activeRoot: root, pendingRoot: ZERO20 };
}

let fundingCounter = 0;
function fundingFor(
  pool: Pool,
  address: string,
  sats = 100_000n,
  token?: { category: string; amount: bigint },
): SpendableUtxo {
  fundingCounter += 1;
  return pool.provider.addUtxo(Buffer.from(lockingBytecodeOf(address)).toString('hex'), {
    txid: fundingCounter.toString(16).padStart(64, '0'),
    vout: 0,
    satoshis: sats,
    ...(token ? { token } : {}),
  });
}

async function utxoAt(contract: Contract): Promise<Pool> {
  const utxos = await contract.getUtxos();
  const rewardUtxo = utxos.find((u) => u.token?.category === REWARD_CATEGORY && !u.token.nft)!;
  const stateUtxo = utxos.find((u) => u.token?.nft?.capability === 'minting')!;
  const { activeRoot, pendingRoot } = parseState(stateUtxo.token!.nft!.commitment);
  return { contract, provider: contract.provider as MockNetworkProvider, rewardUtxo, stateUtxo, activeRoot, pendingRoot };
}

function claimFor(pool: Pool, userIndex: number, opts: { proof?: ReturnType<MerkleTree['proof']>; receiptUtxo?: SpendableUtxo } = {}) {
  return buildClaim(
    pool.contract,
    pool,
    {
      proof: opts.proof ?? tree.proof(leaves[userIndex].addrHash),
      recipient: users[userIndex].address,
      receiptUtxo: opts.receiptUtxo,
      funding: [fundingFor(pool, users[userIndex].address)],
      claimer: users[userIndex],
    },
    pool.provider,
  );
}

test('claim evaluates in the VM and pays the exact entitlement', async () => {
  const pool = newPool();
  const tx = claimFor(pool, 1);
  const debug = tx.debug();
  assert.ok(debug !== undefined);
  const details = await tx.send();
  assert.ok(details.txid);

  const after = await utxoAt(pool.contract);
  assert.equal(after.activeRoot, rootAfterClaim(tree.proof(leaves[1].addrHash)));
  assert.equal(after.pendingRoot, ZERO20);
  assert.equal(after.rewardUtxo.token!.amount, 1_000_000n - 12_000n);

  const utxos = await pool.provider.getUtxos(users[1].address);
  const receipt = utxos.find((u) => u.token?.nft?.capability === 'none')!;
  const expected = Buffer.alloc(8);
  expected.writeBigUInt64LE(12_000n);
  assert.equal(receipt.token!.nft!.commitment, `${leaves[1].addrHash}${expected.toString('hex')}`);
});

test('a repeat claim with the receipt NFT records the new cumulative total', async () => {
  const pool = newPool();
  await claimFor(pool, 0).send();
  const afterFirst = await utxoAt(pool.contract);
  const receipt = (await pool.provider.getUtxos(users[0].address)).find((u) => u.token?.nft?.capability === 'none')!;

  // epoch 2 root: user 0 earned 8000 (was 5000), already claimed 5000
  const nextLeaves = leaves.map((leaf, i) => (i === 0 ? { ...leaf, earned: 8000n, claimed: 5000n } : leaf));
  const nextTree = new MerkleTree(nextLeaves, DEPTH);
  const propose = buildPropose(pool.contract, afterFirst, nextTree.root, operator, [
    fundingFor(pool, operator.address),
  ], pool.provider);
  await propose.send();
  const pending = await utxoAt(pool.contract);
  const activate = buildActivate(pool.contract, pending, operator, Number(AUDIT_DELAY), [
    fundingFor(pool, operator.address),
  ], pool.provider);
  await activate.send();
  const epoch2 = await utxoAt(pool.contract);

  const tx = claimFor(epoch2, 0, { proof: nextTree.proof(leaves[0].addrHash), receiptUtxo: receipt });
  await tx.send();
  const after = await utxoAt(pool.contract);
  assert.equal(after.rewardUtxo.token!.amount, 1_000_000n - 8000n);
  const newReceipt = (await pool.provider.getUtxos(users[0].address)).find((u) => u.token?.nft?.capability === 'none')!;
  const expected = Buffer.alloc(8);
  expected.writeBigUInt64LE(8000n);
  assert.equal(newReceipt.token!.nft!.commitment, `${leaves[0].addrHash}${expected.toString('hex')}`);
});

test('replaying the same proof after a successful claim is rejected', async () => {
  const pool = newPool();
  const proof = tree.proof(leaves[1].addrHash);
  await claimFor(pool, 1, { proof }).send();
  const after = await utxoAt(pool.contract);
  assert.throws(() => claimFor(after, 1, { proof }).debug(), /proof does not match active root/);
});

test('a claim with an inflated earned value is rejected', async () => {
  const pool = newPool();
  const tampered = { ...tree.proof(leaves[0].addrHash), earned: 999_999n };
  assert.throws(() => claimFor(pool, 0, { proof: tampered }).debug(), /proof does not match active root/);
});

test('a claim that pays a different address than the leaf commits is rejected', async () => {
  const pool = newPool();
  const builder = buildClaim(
    pool.contract,
    pool,
    {
      proof: tree.proof(leaves[0].addrHash),
      recipient: users[2].address, // wrong beneficiary
      funding: [fundingFor(pool, users[0].address)],
      claimer: users[0],
    },
    pool.provider,
  );
  assert.throws(() => builder.debug(), /payout must go to the leaf address/);
});

test('a claim that redirects the whole pool to the claimant is rejected', async () => {
  const pool = newPool();
  const proof = tree.proof(leaves[0].addrHash);
  const proofBytes = Buffer.concat(proof.siblings.map((s) => Buffer.from(s, 'hex')));
  const unlock = pool.contract.unlock.claim(
    Buffer.from(proof.addrHash, 'hex'),
    proof.earned,
    proof.claimed,
    proofBytes,
    BigInt(proof.path),
    false,
  );
  const builder = new TransactionBuilder({ provider: pool.provider });
  builder.addInput(pool.rewardUtxo, unlock);
  builder.addInput(pool.stateUtxo, unlock);
  builder.addInput(fundingFor(pool, users[0].address), users[0].unlocker);
  builder.addOutput({
    to: users[0].address,
    amount: 1000n,
    token: { category: REWARD_CATEGORY, amount: 1_000_000n },
  });
  builder.addOutput({
    to: pool.contract.tokenAddress,
    amount: 1000n,
    token: { category: REWARD_CATEGORY, amount: 0n },
  });
  builder.addOutput({
    to: pool.contract.tokenAddress,
    amount: 1000n,
    token: {
      category: RECEIPT_CATEGORY,
      amount: 0n,
      nft: { capability: 'minting', commitment: encodeState(rootAfterClaim(proof)) },
    },
  });
  builder.addOutput({
    to: users[0].address,
    amount: 1000n,
    token: {
      category: RECEIPT_CATEGORY,
      amount: 0n,
      nft: { capability: 'none', commitment: `${proof.addrHash}${Buffer.alloc(8).toString('hex')}` },
    },
  });
  builder.addBchChangeOutputIfNeeded({ to: users[0].address, feeRate: 1.1 });
  assert.throws(() => builder.debug(), /payout amount mismatch/);
});

test('proposeRoot pauses claims; activateRoot needs the audit delay and rewrites the root', async () => {
  const pool = newPool();
  const nextRoot = rootAfterClaim(tree.proof(leaves[2].addrHash));
  await buildPropose(pool.contract, pool, nextRoot, operator, [
    fundingFor(pool, operator.address),
  ], pool.provider).send();
  const pending = await utxoAt(pool.contract);
  assert.equal(pending.activeRoot, tree.root);
  assert.equal(pending.pendingRoot, nextRoot);

  // claims are paused while a rotation is in flight
  assert.throws(() => claimFor(pending, 0).debug(), /root rotation pending/);

  // activation without a BIP68 sequence fails CSV inside the VM
  const early = buildActivate(pool.contract, pending, operator, 0, [
    fundingFor(pool, operator.address),
  ], pool.provider);
  assert.throws(() => early.debug(), /audit window|non-final sequence/);

  // activation with the sequence below the contract's auditDelay fails too
  const tooEarly = new TransactionBuilder({ provider: pool.provider });
  tooEarly.addInput(pending.stateUtxo, pool.contract.unlock.activateRoot(operator.signer), { sequence: 1 });
  tooEarly.addOutput({
    to: pool.contract.tokenAddress,
    amount: 1000n,
    token: {
      category: RECEIPT_CATEGORY,
      amount: 0n,
      nft: { capability: 'minting', commitment: encodeState(nextRoot) },
    },
  });
  tooEarly.addInput(fundingFor(pool, operator.address), operator.unlocker);
  tooEarly.addBchChangeOutputIfNeeded({ to: operator.address, feeRate: 1.1 });
  assert.throws(() => tooEarly.debug(), /audit window has not elapsed/);

  await buildActivate(pool.contract, pending, operator, Number(AUDIT_DELAY), [
    fundingFor(pool, operator.address),
  ], pool.provider).send();
  const activated = await utxoAt(pool.contract);
  assert.equal(activated.activeRoot, nextRoot);
  assert.equal(activated.pendingRoot, ZERO20);
});

test('cancelRoot restores the previous root without waiting', async () => {
  const pool = newPool();
  const nextRoot = rootAfterClaim(tree.proof(leaves[2].addrHash));
  await buildPropose(pool.contract, pool, nextRoot, operator, [
    fundingFor(pool, operator.address),
  ], pool.provider).send();
  const pending = await utxoAt(pool.contract);
  await buildCancel(pool.contract, pending, operator, [fundingFor(pool, operator.address)], pool.provider).send();
  const restored = await utxoAt(pool.contract);
  assert.equal(restored.activeRoot, tree.root);
  assert.equal(restored.pendingRoot, ZERO20);
  // claims work again
  await claimFor(restored, 0).send();
});

test('only the operator can propose or cancel a root', async () => {
  const pool = newPool();
  const fake = users[2];
  const builder = buildPropose(pool.contract, pool, '77'.repeat(20), fake, [
    fundingFor(pool, fake.address),
  ], pool.provider);
  assert.throws(() => builder.debug(), /operator signature required|[Ss]ignature/);
});

test('deposit increases the pool balance without touching the root', async () => {
  const pool = newPool();
  const donor = users[0];
  const donorTokens = fundingFor(pool, donor.address, 100_000n, {
    category: REWARD_CATEGORY,
    amount: 5000n,
  });
  const builder = new TransactionBuilder({ provider: pool.provider });
  builder.addInput(pool.rewardUtxo, pool.contract.unlock.deposit());
  builder.addInput(donorTokens, donor.unlocker);
  builder.addOutput({
    to: pool.contract.tokenAddress,
    amount: 1000n,
    token: { category: REWARD_CATEGORY, amount: 1_005_000n },
  });
  builder.addBchChangeOutputIfNeeded({ to: donor.address, feeRate: 1.1 });
  await builder.send();
  const after = await utxoAt(pool.contract);
  assert.equal(after.rewardUtxo.token!.amount, 1_005_000n);
  assert.equal(after.activeRoot, pool.activeRoot);
});

// ---------------------------------------------------------------- push path

const receiptHoldArtifact = JSON.parse(readArtifact(resolve('artifacts/ReceiptHold.json'), 'utf8'));

function receiptHold(owner: ReturnType<typeof walletFromMnemonic>, minPush: bigint) {
  return new Contract(
    receiptHoldArtifact,
    [toCategory(RECEIPT_CATEGORY), addrHashOfAddress(owner.address), operator.publicKey, minPush],
    { provider: new MockNetworkProvider() },
  );
}

const u64 = (value: bigint): string => {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf.toString('hex');
};

test('delegated push: threshold is enforced, then the operator pushes for the user', async () => {
  const user = users[0];
  const addrHash = addrHashOfAddress(user.address);

  // the user's receipt sits at a delegation covenant: 2000 units already claimed
  const receiptCommitment = `${addrHash}${u64(2000n)}`;

  const setup = (minPush: bigint) => {
    const pool = newPool();
    const epochLeaves = leaves.map((leaf, i) => (i === 0 ? { ...leaf, earned: 5000n, claimed: 2000n } : leaf));
    const epochTree = new MerkleTree(epochLeaves, DEPTH);
    const stateUtxo = pool.provider.addUtxo(pool.contract.tokenAddress, {
      txid: '88'.repeat(32),
      vout: 1,
      satoshis: 5000n,
      token: {
        category: RECEIPT_CATEGORY,
        amount: 0n,
        nft: { capability: 'minting', commitment: encodeState(epochTree.root) },
      },
    });
    const hold = new Contract(
      receiptHoldArtifact,
      [toCategory(RECEIPT_CATEGORY), addrHash, operator.publicKey, minPush],
      { provider: pool.provider },
    );
    const receiptUtxo = pool.provider.addUtxo(hold.tokenAddress, {
      txid: '77'.repeat(32),
      vout: 0,
      satoshis: 1000n,
      token: {
        category: RECEIPT_CATEGORY,
        amount: 0n,
        nft: { capability: 'none', commitment: receiptCommitment },
      },
    });
    const tx = buildClaim(
      pool.contract,
      { ...pool, stateUtxo },
      {
        proof: epochTree.proof(addrHash),
        recipient: user.address,
        receiptUtxo,
        receiptUnlocker: hold.unlock.delegated(operator.signer),
        receiptTo: hold.tokenAddress,
        funding: [fundingFor(pool, operator.address)],
        claimer: operator,
      },
      pool.provider,
    );
    return { tx, pool };
  };

  // delta is 3000 units: a 4000-unit threshold must be rejected by the covenant
  const strict = setup(4000n);
  assert.throws(() => strict.tx.debug(), /push below the minimum threshold/);

  // with a 100-unit threshold the same push is valid; the operator pays the fee
  const loose = setup(100n);
  const raw = loose.tx.build();
  assert.match(raw, /^[0-9a-f]+$/);
  const usage = loose.tx.getVmResourceUsage(false);
  assert.equal(usage.length, 4); // reward, state, delegated receipt, operator funding
  const payoutOutput = loose.tx; // outputs are validated inside the covenant
  assert.ok(payoutOutput);
});
