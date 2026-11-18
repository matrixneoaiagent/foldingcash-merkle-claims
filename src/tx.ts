import { type TransactionBuilder } from 'cashscript';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const EXPLORER = 'https://chipnet.imaginary.cash/tx/';
export const RECORD_PATH = process.env.FC_RECORD ?? resolve('demo/transactions.jsonl');

export function explorerTx(txid: string): string {
  return `${EXPLORER}${txid}`;
}

/** Broadcasts a transaction, prints the txid + explorer link, and records it. */
export async function sendTx(builder: TransactionBuilder, label: string): Promise<string> {
  const details = await builder.send();
  const txid = details.txid;
  console.log(`\n[${label}]`);
  console.log(`  txid     : ${txid}`);
  console.log(`  explorer : ${explorerTx(txid)}`);
  mkdirSync(resolve(RECORD_PATH, '..'), { recursive: true });
  appendFileSync(
    RECORD_PATH,
    `${JSON.stringify({ at: new Date().toISOString(), label, txid, explorer: explorerTx(txid) })}\n`,
  );
  return txid;
}

/** Prints a locally evaluated transaction's VM resource usage without broadcasting. */
export function reportVmUsage(builder: TransactionBuilder, label: string): void {
  const usage = builder.getVmResourceUsage(false);
  console.log(`\n[${label}] VM resource usage (local evaluation, not broadcast)`);
  usage.forEach((entry, index) => {
    console.log(`  input ${index}: ${JSON.stringify(entry)}`);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function waitForBlocks(
  provider: { getBlockHeight: () => Promise<number> },
  blocks: number,
  pollMs = 30_000,
): Promise<number> {
  const start = await provider.getBlockHeight();
  console.log(`waiting for ${blocks} block(s) from height ${start} (poll ${pollMs / 1000}s)`);
  for (;;) {
    await sleep(pollMs);
    const height = await provider.getBlockHeight();
    console.log(`  height ${height} (+${height - start})`);
    if (height - start >= blocks) return height;
  }
}
