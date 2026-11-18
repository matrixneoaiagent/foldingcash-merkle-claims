/**
 * Operator: publishes a new epoch root (phase 1 of 2).
 *
 *   proposeRoot(activeRoot -> pendingRoot)
 *
 * After this transaction claims are paused: the pending UTXO must age
 * `auditDelay` blocks before it can be activated, which is the audit window
 * watchers get to recompute the root from the published leaf set.
 *
 * Usage: tsx scripts/propose-root.ts
 */
import { loadDeployment, loadTree, poolContract, provider, readPool, walletAt, ZERO20, buildPropose } from '../src/pool';
import { reportVmUsage, sendTx } from '../src/tx';

const deployment = loadDeployment();
const providerInstance = provider();
const operator = walletAt(deployment.operatorIndex);
const treeFile = loadTree();
const contract = poolContract(deployment, providerInstance);
const state = await readPool(contract, deployment);

if (state.pendingRoot !== ZERO20) throw new Error('a rotation is already in flight');
if (state.activeRoot === treeFile.root) throw new Error('the local tree root is already the active root');

console.log(`epoch ${treeFile.epoch}: proposing root ${treeFile.root}`);
console.log(`  current active root: ${state.activeRoot}`);
console.log(`  audit delay        : ${deployment.auditDelay} blocks`);

const funding = (await providerInstance.getUtxos(operator.address)).filter((u) => !u.token);
const builder = buildPropose(contract, state, treeFile.root, operator, funding.slice(0, 1), providerInstance);
reportVmUsage(builder, 'proposeRoot');
await sendTx(builder, `propose root for epoch ${treeFile.epoch} (${treeFile.leaves.length} leaves)`);
console.log(`\nclaims are paused until this proposal is at least ${deployment.auditDelay} blocks old.`);
console.log(`next: tsx scripts/activate-root.ts (after the audit window)`);
