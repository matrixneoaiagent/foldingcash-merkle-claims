/**
 * Activates the pending root, retrying until the network accepts it.
 *
 * On Chipnet the node that accepts the broadcast can sit a block or two behind
 * the Electrum server's reported tip, so a CSV-satisfying transaction is
 * sometimes rejected with "BIP68 sequence lock not satisfied" until that node
 * catches up. This script retries (and never changes the sequence it asks for).
 *
 * Usage: tsx scripts/activate-when-ready.ts [maxAttempts] [pollMs]
 */
import { loadDeployment, loadTree, poolContract, provider, readPool, walletAt, ZERO20, buildActivate } from '../src/pool';
import { sleep, sendTx } from '../src/tx';

const attempts = Number(process.argv[2] ?? '60');
const pollMs = Number(process.argv[3] ?? '60000');

const deployment = loadDeployment();
const providerInstance = provider();
const operator = walletAt(deployment.operatorIndex);
const treeFile = loadTree();
const contract = poolContract(deployment, providerInstance);

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const state = await readPool(contract, deployment);
  if (state.pendingRoot === ZERO20) {
    console.log(`no rotation in flight; active root is ${state.activeRoot}`);
    process.exit(0);
  }
  if (state.pendingRoot !== treeFile.root) throw new Error('pending root does not match the local tree');
  const funding = (await providerInstance.getUtxos(operator.address)).filter((u) => !u.token);
  const builder = buildActivate(contract, state, operator, deployment.auditDelay, funding.slice(0, 1), providerInstance);
  const height = await providerInstance.getBlockHeight();
  try {
    const txid = await builder.send();
    console.log(`\nattempt ${attempt}: accepted (reported tip ${height})`);
    console.log(`  txid     : ${txid.txid}`);
    console.log(`  explorer : https://chipnet.imaginary.cash/tx/${txid.txid}`);
    process.exit(0);
  } catch (error) {
    const message = (error as Error).message.split('\n')[0];
    console.log(`attempt ${attempt}: reported tip ${height} — ${message}`);
    if (!/BIP68|non-BIP68-final|network rules/.test(message)) throw error;
    await sleep(pollMs);
  }
}
console.log('gave up waiting; re-run later');
process.exit(1);
