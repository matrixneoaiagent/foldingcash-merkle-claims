/**
 * Funds demo users with Chipnet sats so they can pay their own claim fees and
 * token dust (this is testnet plumbing, not part of the protocol).
 *
 * Usage: tsx scripts/fund-users.ts <count> [satsPerUser]
 */
import { TransactionBuilder } from 'cashscript';
import { provider, walletAt } from '../src/pool';
import { sendTx } from '../src/tx';

const count = Number(process.argv[2] ?? '3');
const sats = BigInt(process.argv[3] ?? '15000');

const providerInstance = provider();
const operator = walletAt(0);
const utxos = (await providerInstance.getUtxos(operator.address))
  .filter((u) => !u.token)
  .sort((a, b) => (a.satoshis > b.satoshis ? -1 : 1));
const funding = utxos[0];
if (!funding) throw new Error('operator has no BCH UTXO');

const builder = new TransactionBuilder({ provider: providerInstance });
builder.addInput(funding, operator.unlocker);
for (let i = 1; i <= count; i += 1) {
  builder.addOutput({ to: walletAt(i).address, amount: sats });
}
builder.addBchChangeOutputIfNeeded({ to: operator.address, feeRate: 1.1 });
await sendTx(builder, `fund demo users 1..${count} with ${sats} sats each`);
process.exit(0);
