/**
 * Cost model: trusted monthly push vs. Merkle pull claims.
 *
 * Every transaction size below is measured by building the actual transaction
 * shape with CashScript's TransactionBuilder against an in-memory mock provider
 * (`getTransactionSize()`), not estimated from a formula. Change the fee rate and
 * BCH price with FC_FEE_RATE / FC_BCH_USD to re-run the table.
 *
 * Usage: tsx scripts/cost-model.ts
 */
import { Contract, MockNetworkProvider, TransactionBuilder } from 'cashscript';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { addrHashOfAddress, lockingBytecodeOf } from '../src/cash';
import { toContractCategory, walletFromMnemonic } from '../src/wallet';
import { encodeState, treeFromFile } from '../src/pool';
import { rootAfterClaim } from '../src/merkle';

const FEE_RATE = Number(process.env.FC_FEE_RATE ?? '1');
const BCH_USD = Number(process.env.FC_BCH_USD ?? '500');
const USERS = [100, 1_000, 10_000];
const DUST = 1_000n; // satoshis locked in a token-carrying output

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const operator = walletFromMnemonic(MNEMONIC, 0);
const user = walletFromMnemonic(MNEMONIC, 1);
const REWARD = 'aa'.repeat(32);
const RECEIPT = 'bb'.repeat(32);
const artifact = JSON.parse(readFileSync(resolve('artifacts/RewardPool.json'), 'utf8'));

function mock(): { provider: MockNetworkProvider; contract: Contract } {
  const provider = new MockNetworkProvider();
  const contract = new Contract(
    artifact,
    [toContractCategory(REWARD), toContractCategory(RECEIPT), operator.publicKey, 2n],
    { provider },
  );
  return { provider, contract };
}

/** Operator pushes tokens to one user: 1 token input -> user output + change. */
function pushSize(): number {
  const { provider } = mock();
  const input = provider.addUtxo(operator.tokenAddress, {
    txid: '01'.repeat(32),
    vout: 0,
    satoshis: 1_000_000n,
    token: { category: REWARD, amount: 1_000_000n },
  });
  const builder = new TransactionBuilder({ provider });
  builder.addInput(input, operator.unlocker);
  builder.addOutput({ to: user.address, amount: DUST, token: { category: REWARD, amount: 500n } });
  builder.addBchChangeOutputIfNeeded({ to: operator.address, feeRate: FEE_RATE });
  return Number(builder.getTransactionSize());
}

/** A full pull claim: pool tokens + state NFT + 1 funding input -> 5 outputs. */
function claimSize(): number {
  const { provider, contract } = mock();
  const treeFile = JSON.parse(readFileSync(resolve('demo/tree.json'), 'utf8'));
  const tree = treeFromFile(treeFile);
  const leaf = treeFile.leaves[0] as { addrHash: string; address: string };
  const proof = tree.proof(leaf.addrHash);
  const rewardUtxo = provider.addUtxo(contract.tokenAddress, {
    txid: '02'.repeat(32),
    vout: 0,
    satoshis: 1_000n,
    token: { category: REWARD, amount: 1_000_000n },
  });
  const stateUtxo = provider.addUtxo(contract.tokenAddress, {
    txid: '03'.repeat(32),
    vout: 1,
    satoshis: 1_000n,
    token: { category: RECEIPT, amount: 0n, nft: { capability: 'minting', commitment: encodeState(tree.root) } },
  });
  // a claimant-owned BCH input (same 1-in/1-out size whoever signs it)
  const funding = provider.addUtxo(operator.address, {
    txid: '04'.repeat(32),
    vout: 0,
    satoshis: 20_000n,
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
  builder.addInput(funding, operator.unlocker);
  builder.addOutput({ to: leaf.address, amount: DUST, token: { category: REWARD, amount: payout } });
  builder.addOutput({
    to: contract.tokenAddress,
    amount: DUST,
    token: { category: REWARD, amount: 1_000_000n - payout },
  });
  builder.addOutput({
    to: contract.tokenAddress,
    amount: DUST,
    token: {
      category: RECEIPT,
      amount: 0n,
      nft: { capability: 'minting', commitment: encodeState(rootAfterClaim(proof)) },
    },
  });
  builder.addOutput({
    to: leaf.address,
    amount: DUST,
    token: {
      category: RECEIPT,
      amount: 0n,
      nft: { capability: 'none', commitment: `${proof.addrHash}0000000000000000` },
    },
  });
  builder.addBchChangeOutputIfNeeded({ to: operator.address, feeRate: FEE_RATE });
  return Number(builder.getTransactionSize());
}

/** Root rotation: state NFT + 1 operator funding input -> 2 outputs. */
function rotationSize(): number {
  const { provider, contract } = mock();
  const stateUtxo = provider.addUtxo(contract.tokenAddress, {
    txid: '05'.repeat(32),
    vout: 0,
    satoshis: 1_000n,
    token: { category: RECEIPT, amount: 0n, nft: { capability: 'minting', commitment: encodeState('11'.repeat(20)) } },
  });
  const funding = provider.addUtxo(operator.address, {
    txid: '06'.repeat(32),
    vout: 0,
    satoshis: 20_000n,
  });
  const builder = new TransactionBuilder({ provider });
  builder.addInput(stateUtxo, contract.unlock.proposeRoot(Buffer.from('22'.repeat(20), 'hex'), operator.signer));
  builder.addInput(funding, operator.unlocker);
  builder.addOutput({
    to: contract.tokenAddress,
    amount: DUST,
    token: {
      category: RECEIPT,
      amount: 0n,
      nft: { capability: 'minting', commitment: encodeState('11'.repeat(20), '22'.repeat(20)) },
    },
  });
  builder.addBchChangeOutputIfNeeded({ to: operator.address, feeRate: FEE_RATE });
  return Number(builder.getTransactionSize());
}

const push = pushSize();
const claim = claimSize();
const rotation = rotationSize();
const fee = (bytes: number): bigint => BigInt(Math.ceil(bytes * FEE_RATE));
const usd = (sats: bigint): string => `$${((Number(sats) / 1e8) * BCH_USD).toFixed(2)}`;
const bch = (sats: bigint): string => (Number(sats) / 1e8).toFixed(6);

console.log(`measured sizes (bytes): push=${push} claim=${claim} rotation=${rotation}`);
console.log(`fee rate ${FEE_RATE} sat/B, BCH = $${BCH_USD}, monthly epoch, dust ${DUST} sats/token output\n`);

const rows: string[] = [];
rows.push('| users | push: operator tx fees | push: dust locked | push: bytes/epoch | pull: operator tx fees | pull: bytes/epoch | pull: user-paid fees (all claim) |');
rows.push('|---|---|---|---|---|---|---|');
for (const users of USERS) {
  const pushFees = fee(push) * BigInt(users);
  const pushDust = DUST * BigInt(users);
  const pushBytes = push * users;
  const pullFees = fee(rotation) * 2n; // propose + activate
  const pullBytes = rotation * 2;
  const userFees = fee(claim) * BigInt(users);
  rows.push(
    `| ${users.toLocaleString('en-US')} | ${pushFees} sats (${bch(pushFees)} BCH, ${usd(pushFees)}) | ${pushDust} sats (${bch(pushDust)} BCH) | ${(pushBytes / 1024).toFixed(1)} KiB | ${pullFees} sats (${bch(pullFees)} BCH, ${usd(pullFees)}) | ${(pullBytes / 1024).toFixed(1)} KiB | ${userFees} sats (${bch(userFees)} BCH, ${usd(userFees)}) |`,
  );
}
console.log(rows.join('\n'));

const pad = 20;
console.log(`\nper-claim cost: ${fee(claim)} sats (${usd(fee(claim))}) paid by the claimant, of which`);
console.log(`  ${DUST * 2n} sats is token dust that stays in the claimant's own outputs (recoverable)`);
console.log(`\nper-push cost: ${fee(push)} sats (${usd(fee(push))}) paid by the operator + ${DUST} sats of dust locked`);
console.log(`\noperator cost is O(1) per epoch in the pull model: ${fee(rotation) * 2n} sats (${usd(fee(rotation) * 2n)}) regardless of leaf count`);
console.log(`bytespace per epoch: push ${push} B/user vs pull ${rotation * 2} B total`);
console.log(`\n(a claim is ${(claim / push).toFixed(1)}x a push because it carries the 9-level proof, the state NFT and the receipt NFT)`);
console.log(`parameter pad: ${' '.repeat(pad)}FC_FEE_RATE, FC_BCH_USD`);
