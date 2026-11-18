/**
 * Operator: activates a proposed root (phase 2 of 2).
 *
 * The pending state UTXO must be at least `auditDelay` blocks old. The covenant
 * enforces this with OP_CHECKSEQUENCEVERIFY against the UTXO's own BIP68
 * relative locktime, so the delay cannot be skipped by re-signing, and nothing
 * else can spend (and therefore reset) that UTXO while it is pending.
 *
 * Usage: tsx scripts/activate-root.ts [--force-sequence]
 */
import { loadDeployment, loadTree, poolContract, provider, readPool, walletAt, ZERO20, buildActivate } from '../src/pool';
import { reportVmUsage, sendTx, waitForBlocks } from '../src/tx';

const deployment = loadDeployment();
const providerInstance = provider();
const operator = walletAt(deployment.operatorIndex);
const treeFile = loadTree();
const contract = poolContract(deployment, providerInstance);
const state = await readPool(contract, deployment);

if (state.pendingRoot === ZERO20) throw new Error('no rotation in flight');
if (state.pendingRoot !== treeFile.root) throw new Error('pending root does not match the local tree');

const funding = (await providerInstance.getUtxos(operator.address)).filter((u) => !u.token);
const buildWith = (sequence: number) =>
  buildActivate(contract, state, operator, sequence, funding.slice(0, 1), providerInstance);

console.log(`activating epoch ${treeFile.epoch} root ${state.pendingRoot}`);
const height = await providerInstance.getBlockHeight();
console.log(`  chain height now: ${height}`);
console.log(`  pending UTXO    : ${state.stateUtxo.txid}:${state.stateUtxo.vout}`);

const probe = buildWith(deployment.auditDelay);
reportVmUsage(probe, 'activateRoot');
await sendTx(probe, `activate epoch ${treeFile.epoch} root`);
console.log(`\nclaims are live again under root ${state.pendingRoot}`);
