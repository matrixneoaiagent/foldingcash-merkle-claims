/**
 * Pool status: on-chain state, balances, and a root check against the local tree.
 *
 * Usage: tsx scripts/status.ts
 */
import { loadDeployment, loadTree, poolContract, provider, readPool, walletAt, ZERO20, treeFromFile } from '../src/pool';

const deployment = loadDeployment();
const providerInstance = provider();
const contract = poolContract(deployment, providerInstance);
const state = await readPool(contract, deployment);
const tree = (() => {
  try {
    return treeFromFile(loadTree());
  } catch {
    return undefined;
  }
})();

console.log(`contract      : ${contract.address}`);
console.log(`  token addr  : ${contract.tokenAddress}`);
console.log(`  script size : ${contract.bytesize} bytes (${contract.opcount} opcodes)`);
console.log(`reward cat    : ${deployment.rewardCategory}`);
console.log(`receipt cat   : ${deployment.receiptCategory}`);
console.log(`operator      : ${deployment.operatorAddress}`);
console.log(`audit delay   : ${deployment.auditDelay} blocks`);
console.log(`active root   : ${state.activeRoot}`);
console.log(`pending root  : ${state.pendingRoot === ZERO20 ? '(none)' : state.pendingRoot}`);
console.log(`reward balance: ${state.rewardUtxo.token!.amount} units`);
console.log(`pool UTXOs    :`);
for (const utxo of await contract.getUtxos()) {
  const token = utxo.token;
  console.log(
    `  ${utxo.txid}:${utxo.vout} ${utxo.satoshis} sats ` +
      (token
        ? `token ${token.category.slice(0, 8)}… amount=${token.amount}` +
          (token.nft ? ` nft=${token.nft.capability} commitment=${token.nft.commitment}` : '')
        : 'no token'),
  );
}
if (tree) {
  console.log(`local tree    : epoch ${loadTree().epoch}, ${tree.size} leaves, root ${tree.root}`);
  console.log(`root matches  : ${tree.root === state.activeRoot ? 'yes' : 'NO — run scripts/sync.ts'}`);
}
console.log(`operator BCH  : ${(await providerInstance.getUtxos(walletAt(deployment.operatorIndex).address))
  .filter((u) => !u.token)
  .reduce((sum, u) => sum + u.satoshis, 0n)} sats`);
