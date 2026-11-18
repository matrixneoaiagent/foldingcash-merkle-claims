/**
 * Operator push path: the operator submits a claim on behalf of a user who
 * delegated their receipt to a ReceiptHold covenant.
 *
 * The operator pays the fee and the token dust, exactly like today's monthly
 * push, but:
 *   - the covenant enforces the minimum push threshold on-chain,
 *   - the pool can only pay the address committed in the Merkle leaf, so the
 *     operator never has custody of the reward,
 *   - the receipt stays delegated, so the next push needs no user interaction
 *     at all.
 *
 * Usage: tsx scripts/push.ts <userIndex> [minPush]
 */
import { loadDeployment, loadTree, poolContract, provider, readPool, receiptHoldContract, treeFromFile, walletAt, ZERO20 } from '../src/pool';
import { addrHashOfAddress } from '../src/cash';
import { buildClaim } from '../src/pool';
import { reportVmUsage, sendTx } from '../src/tx';

const userIndex = Number(process.argv[2] ?? '2');
const minPush = BigInt(process.argv[3] ?? '100');

const deployment = loadDeployment();
const providerInstance = provider();
const operator = walletAt(deployment.operatorIndex);
const user = walletAt(userIndex);
const addrHash = addrHashOfAddress(user.address);
const contract = poolContract(deployment, providerInstance);
const state = await readPool(contract, deployment);
const treeFile = loadTree();
const tree = treeFromFile(treeFile);

if (state.activeRoot !== tree.root) throw new Error('local tree out of sync — run scripts/sync.ts');
if (state.pendingRoot !== ZERO20) throw new Error('rotation in flight: claims are paused');

const hold = receiptHoldContract(deployment, user.address, minPush, providerInstance);
const heldUtxos = await providerInstance.getUtxos(hold.address);
const receipt = heldUtxos.find(
  (u) => u.token?.nft?.capability === 'none' && u.token.nft.commitment.startsWith(addrHash),
);
if (!receipt) throw new Error(`no delegated receipt for ${user.address} at ${hold.address} — run scripts/delegate.ts`);

const proof = tree.proof(addrHash);
const outstanding = proof.earned - proof.claimed;
console.log(`pushing user ${userIndex} (${user.address})`);
console.log(`  delegated receipt : ${receipt.txid}:${receipt.vout}`);
console.log(`  outstanding       : ${outstanding} units, threshold ${minPush}`);
if (outstanding < minPush) throw new Error('outstanding balance is below the push threshold; the covenant would reject this push');

const funding = (await providerInstance.getUtxos(operator.address)).filter((u) => !u.token);
const builder = buildClaim(
  contract,
  state,
  {
    proof,
    recipient: user.address,
    receiptUtxo: receipt,
    receiptUnlocker: hold.unlock.delegated(operator.signer),
    receiptTo: hold.tokenAddress,
    funding: funding.slice(0, 2),
    claimer: operator, // the operator pays the fee and the dust
    changeAddress: operator.address,
  },
  providerInstance,
);

reportVmUsage(builder, 'push (delegated claim)');
await sendTx(builder, `operator push for user ${userIndex} (${outstanding} units)`);
