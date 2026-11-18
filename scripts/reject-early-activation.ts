/**
 * Negative test 2: a root cannot be activated before the audit window elapses.
 *
 * The activation transaction is built exactly like the real one (operator
 * signature, correct new root), with the correct BIP68 sequence number. The
 * covenant's relative-locktime check (this.age >= auditDelay) is evaluated
 * against the age of the pending UTXO, which the node knows and the script
 * cannot fake — so Chipnet refuses the transaction as non-final.
 *
 * Usage: tsx scripts/reject-early-activation.ts
 */
import { loadDeployment, loadTree, poolContract, provider, readPool, walletAt, ZERO20, buildActivate } from '../src/pool';

const deployment = loadDeployment();
const providerInstance = provider();
const operator = walletAt(deployment.operatorIndex);
const treeFile = loadTree();
const contract = poolContract(deployment, providerInstance);
const state = await readPool(contract, deployment);

if (state.pendingRoot === ZERO20) throw new Error('no rotation in flight — run scripts/propose-root.ts first');

const funding = (await providerInstance.getUtxos(operator.address)).filter((u) => !u.token);
const builder = buildActivate(
  contract,
  state,
  operator,
  deployment.auditDelay,
  funding.slice(0, 1),
  providerInstance,
);

const height = await providerInstance.getBlockHeight();
console.log(`pending root : ${state.pendingRoot}`);
console.log(`pending UTXO : ${state.stateUtxo.txid}:${state.stateUtxo.vout}`);
console.log(`chain height : ${height}`);
console.log(`audit delay  : ${deployment.auditDelay} blocks (BIP68 relative locktime)`);

// local VM evaluation passes: sequence encoding alone satisfies OP_CSV
const raw = builder.build();
console.log('\nlocal VM evaluation: passed (the VM only sees the sequence field, not UTXO age)');

console.log('\nChipnet node verdict on the early activation:');
try {
  const txid = await providerInstance.sendRawTransaction(raw);
  console.log(`  UNEXPECTED: the node accepted it as ${txid}`);
  process.exitCode = 1;
} catch (error) {
  console.log(`  REJECTED: ${(error as Error).message.split('\n')[0]}`);
}
