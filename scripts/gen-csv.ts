/**
 * Generates the demo leaf set: N simulated Folding@home contributors.
 *
 * Every address is derived from the same disposable Chipnet mnemonic
 * (m/44'/145'/0'/0/1 … /N) because this is a testnet demo; each claim is signed
 * with that user's own key only.  Rewards are deterministic pseudo-random
 * "F@H points" so the demo is reproducible without the real stats file.
 *
 * Output: demo/epochs/epoch-<n>.csv with `address,earned` rows.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { walletAt } from '../src/pool';
import { addrHashOfAddress } from '../src/cash';

const count = Number(process.argv[2] ?? '300');
const epoch = Number(process.argv[3] ?? '1');
const outPath = resolve(`demo/epochs/epoch-${epoch}.csv`);

/** deterministic 32-bit PRNG so the fixture is reproducible */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0x5eed_1eaf);
const rows: string[] = ['address,earned'];
for (let i = 1; i <= count; i += 1) {
  const wallet = walletAt(i);
  // folding points → FLDCH units: a long tail of small contributors plus a few whales
  const r = rand();
  const points = Math.floor(50 + r ** 3 * 250_000);
  rows.push(`${wallet.address},${points}`);
}
mkdirSync(resolve(outPath, '..'), { recursive: true });
writeFileSync(outPath, `${rows.join('\n')}\n`);
console.log(`wrote ${count} leaves to ${outPath}`);
console.log(`first leaf addrHash: ${addrHashOfAddress(rows[1].split(',')[0])}`);
process.exit(0);
