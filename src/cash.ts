import { cashAddressToLockingBytecode, encodeCashAddress } from '@bitauth/libauth';
import { createHash } from 'node:crypto';

export function hash160(data: Uint8Array): Buffer {
  const sha = createHash('sha256').update(data).digest();
  return createHash('ripemd160').update(sha).digest();
}

export function lockingBytecodeOf(address: string): Uint8Array {
  const decoded = cashAddressToLockingBytecode(address);
  if (typeof decoded === 'string') throw new Error(`bad address ${address}: ${decoded}`);
  return decoded.bytecode;
}

/** hash160 of an address' locking bytecode — this is what a Merkle leaf commits to. */
export function addrHashOfAddress(address: string): string {
  return hash160(lockingBytecodeOf(address)).toString('hex');
}

export function addrHashOfLockingBytecode(hex: string): string {
  return hash160(Buffer.from(hex.replace(/^0x/, ''), 'hex')).toString('hex');
}

export function tokenAddressOf(address: string, payload: Uint8Array): string {
  const encoded = encodeCashAddress({ prefix: 'bchtest', type: 'p2pkhWithTokens', payload });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.address;
}
