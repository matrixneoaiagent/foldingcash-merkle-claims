/**
 * Requests Chipnet sats from the BCH Ninja proof-of-work faucet.
 *
 * The faucet gates each request behind a SHA256 proof-of-work challenge
 * (sha256(`${payload}:${nonce}`) <= target) — a spam gate designed for
 * automation, not a human-only CAPTCHA.
 *
 * Usage: tsx scripts/faucet.ts [sats] [address]
 */
import { loadOrCreateWalletFile, walletFromMnemonic } from '../src/wallet';

const FAUCET = 'https://chipnet.bch.ninja';

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${FAUCET}/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

type Challenge = {
  id: string;
  payload: string;
  signature: string;
  target: string;
  expires: number;
  expectedHashes: string;
};

async function main(): Promise<void> {
  const file = loadOrCreateWalletFile();
  const wallet = walletFromMnemonic(file.mnemonic, 0);
  const sats = process.argv[2] ?? '1000000';
  const address = process.argv[3] ?? file.address;
  console.log(`wallet address: ${file.address}`);
  console.log(`requesting ${sats} sats to ${address}`);

  const challenge = await post<Challenge>('challenge', { address, sats });
  const target = BigInt(`0x${challenge.target}`);
  const { createHash } = await import('node:crypto');
  const started = Date.now();
  let nonce = 0n;
  for (;;) {
    const digest = createHash('sha256').update(`${challenge.payload}:${nonce}`).digest();
    if (BigInt(`0x${digest.toString('hex')}`) <= target) break;
    nonce += 1n;
    if (Date.now() > challenge.expires) throw new Error('challenge expired');
  }
  console.log(`proof of work: nonce ${nonce} after ${nonce + 1n} hashes in ${Date.now() - started}ms`);

  const result = await post<{ txid?: string; fee?: number; error?: string }>('claim', {
    payload: challenge.payload,
    signature: challenge.signature,
    nonce: nonce.toString(),
  });
  if (result.error) throw new Error(result.error);
  console.log(`faucet txid: ${result.txid} (fee ${result.fee} sats)`);
  if (!wallet) throw new Error('unreachable');
}

await main();
