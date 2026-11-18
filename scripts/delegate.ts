/**
 * Opt in to the operator push path: move your receipt NFT into a ReceiptHold
 * delegation contract.
 *
 * Usage: tsx scripts/delegate.ts <userIndex> [minPush]
 */
import { TransactionBuilder } from 'cashscript';
import { loadDeployment, provider, receiptHoldContract, walletAt } from '../src/pool';
import { addrHashOfAddress } from '../src/cash';
import { sendTx } from '../src/tx';

const userIndex = Number(process.argv[2] ?? '2');
const minPush = BigInt(process.argv[3] ?? '100');

const deployment = loadDeployment();
const providerInstance = provider();
const user = walletAt(userIndex);
const addrHash = addrHashOfAddress(user.address);
const hold = receiptHoldContract(deployment, user.address, minPush, providerInstance);

const utxos = await providerInstance.getUtxos(user.address);
const receipt = utxos.find(
  (u) =>
    u.token?.category === deployment.receiptCategory &&
    u.token.nft?.capability === 'none' &&
    u.token.nft.commitment.startsWith(addrHash),
);
if (!receipt) throw new Error(`no receipt NFT for ${user.address} — claim something first`);
const bch = utxos.find((u) => !u.token);
if (!bch) throw new Error('user needs a BCH UTXO to pay the delegation fee');

console.log(`delegating receipt ${receipt.txid}:${receipt.vout} (commitment ${receipt.token!.nft!.commitment})`);
console.log(`  to ReceiptHold ${hold.address}`);
console.log(`  owner hash ${addrHash}, minPush ${minPush} units`);

const builder = new TransactionBuilder({ provider: providerInstance });
builder.addInput(receipt, user.unlocker);
builder.addInput(bch, user.unlocker);
builder.addOutput({
  to: hold.tokenAddress,
  amount: 1000n,
  token: {
    category: deployment.receiptCategory,
    amount: 0n,
    nft: { capability: 'none', commitment: receipt.token!.nft!.commitment },
  },
});
builder.addBchChangeOutputIfNeeded({ to: user.address, feeRate: 1.1 });
await sendTx(builder, `delegate user ${userIndex} receipt to the operator push covenant`);
