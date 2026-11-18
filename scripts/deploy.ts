/**
 * Deploys the pool: moves the reward tokens and the state NFT into the
 * contract address and commits the first Merkle root.
 *
 * After this transaction the pool has two UTXOs at the same P2SH32 address:
 *   - 1,000,000 reward tokens (the FL DCH stand-in)
 *   - the minting state NFT with commitment activeRoot || pendingRoot
 *
 * Usage: tsx scripts/deploy.ts
 */
import { TransactionBuilder } from 'cashscript';
import { loadDeployment, poolContract, provider, saveDeployment, walletAt } from '../src/pool';
import { sendTx } from '../src/tx';
import { loadTree, treeFromFile } from '../src/pool';
import { existsSync } from 'node:fs';

const providerInstance = provider();
const wallet = walletAt(0);
const deployment = loadDeployment();
const tree = treeFromFile(loadTree());
if (!existsSync('artifacts/RewardPool.json')) throw new Error('run scripts/build.ts first');

const contract = poolContract(deployment, providerInstance);
const utxos = await providerInstance.getUtxos(wallet.tokenAddress);
const rewardUtxo = utxos.find(
  (u) => u.token?.category === deployment.rewardCategory && !u.token.nft,
);
const stateUtxo = utxos.find(
  (u) => u.token?.category === deployment.receiptCategory && u.token.nft?.capability === 'minting',
);
if (!rewardUtxo || !stateUtxo) throw new Error('reward/state genesis UTXOs not found in the operator wallet');

console.log(`contract address : ${contract.address}`);
console.log(`token address    : ${contract.tokenAddress}`);
console.log(`initial root     : ${tree.root} (depth ${tree.depth}, ${tree.size} leaves)`);

const bchOnly = utxos.filter((u) => !u.token).sort((a, b) => (a.satoshis > b.satoshis ? -1 : 1));
if (!bchOnly[0]) throw new Error('operator needs a BCH UTXO to pay the deployment fee');

const builder = new TransactionBuilder({ provider: providerInstance });
builder.addInput(rewardUtxo, wallet.unlocker);
builder.addInput(stateUtxo, wallet.unlocker);
builder.addInput(bchOnly[0], wallet.unlocker);
builder.addOutput({
  to: contract.tokenAddress,
  amount: 1000n,
  token: { category: deployment.rewardCategory, amount: rewardUtxo.token!.amount },
});
builder.addOutput({
  to: contract.tokenAddress,
  amount: 1000n,
  token: {
    category: deployment.receiptCategory,
    amount: 0n,
    nft: { capability: 'minting', commitment: `${tree.root}${'00'.repeat(20)}` },
  },
});
builder.addBchChangeOutputIfNeeded({ to: wallet.address, feeRate: 1.1 });

const txid = await sendTx(builder, `deploy pool + publish epoch ${loadTree().epoch} root`);
saveDeployment({
  ...deployment,
  contractAddress: contract.address,
  contractTokenAddress: contract.tokenAddress,
  poolFundingTx: txid,
});
console.log(`\ndeployment written to demo/deployment.json`);
process.exit(0);
