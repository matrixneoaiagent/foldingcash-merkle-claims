import {
  deriveHdPath,
  deriveHdPrivateNodeFromBip39Mnemonic,
  encodeCashAddress,
  secp256k1,
  generateBip39Mnemonic,
  type HdPrivateNodeValid,
} from '@bitauth/libauth';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SignatureTemplate, type P2PKHUnlocker } from 'cashscript';

export const NETWORK = 'chipnet' as const;
export const DEFAULT_WALLET_PATH = '/tmp/opencode/foldingcash_chipnet/wallet.json';

const DERIVATION_PATH = (index: number): string => `m/44'/145'/0'/0/${index}`;

export type Wallet = {
  network: string;
  address: string;
  tokenAddress: string;
  lockingBytecode: string;
  publicKey: string;
  privateKey: Uint8Array;
  signer: SignatureTemplate;
  /** P2PKH unlocker for spending this wallet's own UTXOs in a TransactionBuilder */
  unlocker: P2PKHUnlocker;
  path: string;
};

export type WalletFile = {
  network: string;
  address: string;
  tokenAddress: string;
  mnemonic: string;
  created_at: string;
  note: string;
};

export function hash160(data: Uint8Array): Buffer {
  const sha = createHash('sha256').update(data).digest();
  return createHash('ripemd160').update(sha).digest();
}

export function walletFromMnemonic(mnemonic: string, index = 0): Wallet {
  const root = deriveHdPrivateNodeFromBip39Mnemonic(mnemonic);
  if (typeof root === 'string') throw new Error(root);
  const node: HdPrivateNodeValid = deriveHdPath(root, DERIVATION_PATH(index)) as HdPrivateNodeValid;
  const privateKey = node.privateKey;
  const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
  if (typeof publicKey === 'string') throw new Error(publicKey);
  const pkh = hash160(publicKey);
  const address = mustEncode({ type: 'p2pkh', payload: pkh });
  const tokenAddress = mustEncode({ type: 'p2pkhWithTokens', payload: pkh });
  const signer = new SignatureTemplate(privateKey);
  return {
    network: NETWORK,
    address: tokenAddress,
    tokenAddress,
    lockingBytecode: toHex(pkhToLocking(pkh)),
    publicKey: toHex(publicKey),
    privateKey,
    signer,
    unlocker: signer.unlockP2PKH(),
    path: DERIVATION_PATH(index),
  };
}

function mustEncode({ type, payload }: { type: 'p2pkh' | 'p2pkhWithTokens'; payload: Uint8Array }): string {
  const encoded = encodeCashAddress({ prefix: 'bchtest', type, payload });
  if (typeof encoded === 'string') throw new Error(encoded);
  return encoded.address;
}

export function pkhToLocking(pkh: Uint8Array): Uint8Array {
  return Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), Buffer.from(pkh), Buffer.from([0x88, 0xac])]);
}

/**
 * Loads (or creates) the disposable Chipnet test wallet. The mnemonic is never
 * printed and the file is written with mode 600.
 */
export function loadOrCreateWalletFile(path = process.env.FC_WALLET ?? DEFAULT_WALLET_PATH): WalletFile {
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as WalletFile;
    if (parsed.network !== NETWORK) throw new Error(`wallet at ${path} is not a chipnet wallet`);
    return parsed;
  }
  const mnemonic = generateBip39Mnemonic();
  const wallet = walletFromMnemonic(mnemonic, 0);
  const file: WalletFile = {
    network: NETWORK,
    address: wallet.address,
    tokenAddress: wallet.tokenAddress,
    mnemonic,
    created_at: new Date().toISOString(),
    note: 'Disposable Chipnet test wallet for the FoldingCash merkle-claims demo. Testnet only, no value.',
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return file;
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export function fromHex(hex: string): Uint8Array {
  return Buffer.from(hex.replace(/^0x/, ''), 'hex');
}

/** CashToken categories are displayed reversed; contract introspection wants the original order. */
export function toContractCategory(displayHex: string): string {
  return Buffer.from(displayHex.replace(/^0x/, ''), 'hex').reverse().toString('hex');
}
