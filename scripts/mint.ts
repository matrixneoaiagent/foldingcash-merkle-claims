/**
 * Mints the two Chipnet CashToken categories the demo needs:
 *
 *   1. the FLDCH stand-in: a plain fungible token category, 1,000,000 units
 *      (FL DCH on mainnet is category 0adb865e…41c640 — this one plays its role
 *      on Chipnet because nobody can mint NFTs in the real FLDCH category);
 *   2. the receipt/state category: a single MINTING NFT with a 40-byte
 *      commitment. The pool keeps this NFT and uses it to mint per-user receipt
 *      NFTs; it can also rewrite its own commitment, which is where the current
 *      Merkle root lives.
 *
 * Both are real genesis transactions: the category of each is the outpoint txid
 * of the input it spends (CashTokens genesis rule).
 */
import { TransactionBuilder, type SpendableUtxo } from 'cashscript';
import { appendFileSync } from 'node:fs';
import { loadDeployment, provider, saveDeployment, walletAt, DEPLOYMENT_PATH } from '../src/pool';
import { sendTx } from '../src/tx';
import { existsSync } from 'node:fs';

const providerInstance = provider();
const wallet = walletAt(0);
// CashTokens genesis rule: the creating input must spend output 0 of its
// transaction, and the new category ID is that outpoint's txid. So a genesis
// input has to be a `vout: 0` UTXO, and the two genesis transactions need UTXOs
// from two different transactions.
const utxos = (await providerInstance.getUtxos(wallet.tokenAddress)).filter(
  (u) => !u.token && u.vout === 0,
);
if (utxos.length < 2) {
  throw new Error(
    `need 2 BCH-only UTXOs with vout 0 (found ${utxos.length}) — run scripts/split.ts twice`,
  );
}
utxos.sort((a, b) => (a.satoshis > b.satoshis ? -1 : 1));

async function genesis(
  utxo: SpendableUtxo,
  token: { amount: bigint; nft?: { capability: 'none' | 'mutable' | 'minting'; commitment: string } },
  label: string,
): Promise<{ txid: string; category: string }> {
  const category = utxo.txid; // genesis: category == first input outpoint txid (display order)
  const builder = new TransactionBuilder({ provider: providerInstance });
  builder.addInput(utxo, wallet.unlocker);
  builder.addOutput({ to: wallet.tokenAddress, amount: 1000n, token: { category, ...token } });
  builder.addBchChangeOutputIfNeeded({ to: wallet.address, feeRate: 1.1 });
  const txid = await sendTx(builder, label);
  return { txid, category };
}

const reward = await genesis(utxos[0], { amount: 1_000_000n }, 'genesis: FLDCH stand-in (1,000,000 FT)');
const receipt = await genesis(
  utxos[1],
  { amount: 0n, nft: { capability: 'minting', commitment: '00'.repeat(40) } },
  'genesis: receipt/state category (1 minting NFT)',
);

const deployment = existsSync(DEPLOYMENT_PATH) ? loadDeployment() : undefined;
saveDeployment({
  network: 'chipnet',
  createdAt: new Date().toISOString(),
  rewardCategory: reward.category,
  receiptCategory: receipt.category,
  operatorAddress: wallet.address,
  operatorIndex: 0,
  auditDelay: Number(process.env.FC_AUDIT_DELAY ?? '2'),
  depth: Number(process.env.FC_DEPTH ?? '9'),
  contractAddress: deployment?.contractAddress ?? '',
  contractTokenAddress: deployment?.contractTokenAddress ?? '',
  genesisTxs: { reward: reward.txid, receipt: receipt.txid },
});

console.log(`\nreward category  : ${reward.category}`);
console.log(`receipt category : ${receipt.category}`);
appendFileSync(
  'demo/token-mapping.md',
  `\n| reward FT (FL DCH stand-in) | ${reward.category} | genesis tx ${reward.txid} |\n` +
    `| receipt/state NFT category | ${receipt.category} | genesis tx ${receipt.txid} |\n`,
);
process.exit(0);
