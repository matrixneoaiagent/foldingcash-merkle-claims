/**
 * Negative test 3: a receipt NFT is bound to its own leaf.
 *
 * User A's receipt records `hash160(A) || cumulativeEarned(A)`. Handing that
 * receipt to a claim for user B is rejected by the covenant, because the receipt
 * commitment must equal `addrHash(B) || claimed(B)` from the Merkle leaf. This is
 * what stops a receipt being re-used across leaves (or sold as a claim ticket).
 *
 * Usage: tsx scripts/reject-wrong-receipt.ts <userA> <userB>
 */
import { loadDeployment, loadTree, poolContract, provider, readPool, treeFromFile, walletAt, ZERO20, buildClaim } from '../src/pool';
import { addrHashOfAddress } from '../src/cash';

const userA = Number(process.argv[2] ?? '1');
const userB = Number(process.argv[3] ?? '3');

const deployment = loadDeployment();
const providerInstance = provider();
const walletA = walletAt(userA);
const walletB = walletAt(userB);
const addrA = addrHashOfAddress(walletA.address);
const addrB = addrHashOfAddress(walletB.address);

const treeFile = loadTree();
const tree = treeFromFile(treeFile);
const contract = poolContract(deployment, providerInstance);
const state = await readPool(contract, deployment);
if (state.activeRoot !== tree.root) throw new Error('local tree out of sync — run scripts/sync.ts');
if (state.pendingRoot !== ZERO20) throw new Error('rotation in flight: claims are paused');

const receiptA = (await providerInstance.getUtxos(walletA.address)).find(
  (u) => u.token?.category === deployment.receiptCategory && u.token.nft?.commitment.startsWith(addrA),
);
if (!receiptA) throw new Error(`user ${userA} has no receipt NFT`);
const proofB = tree.proof(addrB);
const funding = (await providerInstance.getUtxos(walletB.address)).filter((u) => !u.token);
if (funding.length === 0) throw new Error(`user ${userB} needs a BCH UTXO`);

console.log(`claiming leaf ${addrB} (user ${userB}) with user ${userA}'s receipt ${addrA}`);
console.log(`  receipt commitment: ${receiptA.token!.nft!.commitment}`);

const builder = buildClaim(
  contract,
  state,
  {
    proof: proofB,
    recipient: walletB.address,
    receiptUtxo: receiptA,
    funding,
    claimer: walletB,
  },
  providerInstance,
);

try {
  builder.debug();
  console.log('UNEXPECTED: the covenant accepted a receipt belonging to another leaf');
  process.exitCode = 1;
} catch (error) {
  console.log(`REJECTED: ${(error as Error).message.split('\n')[0]}`);
}
