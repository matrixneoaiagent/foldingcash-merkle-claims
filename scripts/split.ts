/**
 * Splits the test wallet's BCH into a few UTXOs so that subsequent genesis
 * transactions each spend a different outpoint (a CashToken genesis category is
 * the first input's outpoint txid).
 *
 * Usage: tsx scripts/split.ts [count] [sats-per-output]
 */
import { TransactionBuilder } from 'cashscript';
import { provider, walletAt } from '../src/pool';
import { sendTx } from '../src/tx';

const count = Number(process.argv[2] ?? '6');
const sats = BigInt(process.argv[3] ?? '60000');

const providerInstance = provider();
const wallet = walletAt(0);
const utxos = await providerInstance.getUtxos(wallet.tokenAddress);
const bchOnly = utxos.filter((u) => !u.token).sort((a, b) => (a.satoshis > b.satoshis ? -1 : 1));
const largest = bchOnly[0];
if (!largest) throw new Error('no BCH-only UTXO in the wallet');

const builder = new TransactionBuilder({ provider: providerInstance });
builder.addInput(largest, wallet.unlocker);
for (let i = 0; i < count; i += 1) builder.addOutput({ to: wallet.address, amount: sats });
builder.addBchChangeOutputIfNeeded({ to: wallet.address, feeRate: 1.1 });
await sendTx(builder, `split ${largest.txid.slice(0, 8)} into ${count} x ${sats} sats`);
process.exit(0);
