import { ElectrumClient, type ElectrumClientEvents } from '@electrum-cash/network';
import { decodeTransaction, hexToBin } from '@bitauth/libauth';
import { createHash } from 'node:crypto';
import { lockingBytecodeOf } from './cash';

export const ELECTRUM_HOST = process.env.FC_ELECTRUM ?? 'chipnet.bch.ninja';

export function electrumClient(): ElectrumClient<ElectrumClientEvents> {
  return new ElectrumClient<ElectrumClientEvents>('foldingcash-merkle-claims', '1.5.0', ELECTRUM_HOST);
}

export function scriptHashOfAddress(address: string): string {
  // Electrum script hash = sha256(locking bytecode), hex, byte-reversed.
  const digest = createHash('sha256').update(Buffer.from(lockingBytecodeOf(address))).digest();
  return digest.reverse().toString('hex');
}

export type HistoryEntry = { tx_hash: string; height: number };

export async function historyForAddress(client: ElectrumClient<ElectrumClientEvents>, address: string): Promise<HistoryEntry[]> {
  const result = await client.request('blockchain.scripthash.get_history', scriptHashOfAddress(address));
  if (result instanceof Error) throw result;
  return (result as { result: HistoryEntry[] }).result ?? (result as unknown as HistoryEntry[]);
}

export async function rawTransaction(client: ElectrumClient<ElectrumClientEvents>, txid: string): Promise<string> {
  const result = await client.request('blockchain.transaction.get', txid);
  if (result instanceof Error) throw result;
  return (result as { result: string }).result ?? (result as unknown as string);
}

export async function decodedTransaction(client: ElectrumClient<ElectrumClientEvents>, txid: string) {
  const raw = await rawTransaction(client, txid);
  const decoded = decodeTransaction(hexToBin(raw));
  if (typeof decoded === 'string') throw new Error(`cannot decode ${txid}: ${decoded}`);
  return decoded;
}
