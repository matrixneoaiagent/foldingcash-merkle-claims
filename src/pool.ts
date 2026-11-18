import { Contract, ElectrumNetworkProvider, TransactionBuilder, type SpendableUtxo, type Unlocker } from 'cashscript';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadOrCreateWalletFile, toContractCategory, walletFromMnemonic, type Wallet } from './wallet';
import { MerkleTree, rootAfterClaim, type Proof } from './merkle';
import { addrHashOfAddress } from './cash';

export const DEPLOYMENT_PATH = process.env.FC_DEPLOYMENT ?? resolve('demo/deployment.json');
export const TREE_PATH = process.env.FC_TREE ?? resolve('demo/tree.json');
export const DEPTH = 9;
export const ZERO20 = '00'.repeat(20);

export type Deployment = {
  network: 'chipnet';
  createdAt: string;
  rewardCategory: string; // display order
  receiptCategory: string; // display order
  operatorAddress: string;
  operatorIndex: number;
  auditDelay: number;
  depth: number;
  contractAddress: string;
  contractTokenAddress: string;
  genesisTxs: Record<string, string>;
  poolFundingTx?: string;
};

export function loadDeployment(path = DEPLOYMENT_PATH): Deployment {
  return JSON.parse(readFileSync(path, 'utf8')) as Deployment;
}

export function saveDeployment(deployment: Deployment, path = DEPLOYMENT_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(deployment, null, 2)}\n`);
}

export function provider(): ElectrumNetworkProvider {
  return new ElectrumNetworkProvider('chipnet');
}

export function walletAt(index: number): Wallet {
  const file = loadOrCreateWalletFile();
  return walletFromMnemonic(file.mnemonic, index);
}

export function artifact(): unknown {
  return JSON.parse(readFileSync(resolve('artifacts/RewardPool.json'), 'utf8'));
}

export function poolContract(deployment = loadDeployment(), networkProvider = provider()): Contract {
  const operator = walletAt(deployment.operatorIndex);
  return new Contract(
    artifact() as never,
    [
      toContractCategory(deployment.rewardCategory),
      toContractCategory(deployment.receiptCategory),
      operator.publicKey,
      BigInt(deployment.auditDelay),
    ],
    { provider: networkProvider } as never,
  );
}

/** The optional delegation covenant that lets the operator push a user's claims. */
export function receiptHoldContract(
  deployment: Deployment,
  ownerAddress: string,
  minPush: bigint,
  networkProvider = provider(),
): Contract {
  const operator = walletAt(deployment.operatorIndex);
  const artifact = JSON.parse(readFileSync(resolve('artifacts/ReceiptHold.json'), 'utf8'));
  return new Contract(
    artifact as never,
    [
      toContractCategory(deployment.receiptCategory),
      addrHashOfAddress(ownerAddress),
      operator.publicKey,
      minPush,
    ] as never,
    { provider: networkProvider } as never,
  );
}

export type PoolState = {
  rewardUtxo: SpendableUtxo;
  stateUtxo: SpendableUtxo;
  activeRoot: string;
  pendingRoot: string;
};

export function parseState(commitmentHex: string): { activeRoot: string; pendingRoot: string } {
  const hex = commitmentHex.replace(/^0x/, '');
  if (hex.length !== 80) throw new Error(`state commitment must be 40 bytes, got ${hex.length / 2}`);
  return { activeRoot: hex.slice(0, 40), pendingRoot: hex.slice(40, 80) };
}

export function encodeState(activeRoot: string, pendingRoot = ZERO20): string {
  return `${activeRoot}${pendingRoot}`;
}

/** Finds the two pool UTXOs: the reward-token output and the state-NFT output. */
export async function readPool(contract: Contract, deployment: Deployment): Promise<PoolState> {
  const utxos = await contract.getUtxos();
  const rewardUtxo = utxos.find(
    (u) => u.token && u.token.category === deployment.rewardCategory && !u.token.nft,
  );
  const stateUtxo = utxos.find(
    (u) => u.token && u.token.category === deployment.receiptCategory && u.token.nft?.capability === 'minting',
  );
  if (!rewardUtxo) throw new Error('reward-token pool UTXO not found at the contract address');
  if (!stateUtxo) throw new Error('state-NFT pool UTXO not found at the contract address');
  const { activeRoot, pendingRoot } = parseState(stateUtxo.token!.nft!.commitment);
  return { rewardUtxo, stateUtxo, activeRoot, pendingRoot };
}

export function isPending(pendingRoot: string): boolean {
  return pendingRoot !== ZERO20;
}

// ---------------------------------------------------------------- tx builders

export type ClaimArgs = {
  proof: Proof;
  /** address the payout and the receipt must be sent to (the address committed in the leaf) */
  recipient: string;
  /** locking bytecode / address that must hold the receipt after the claim (defaults to recipient) */
  receiptTo?: string | Uint8Array;
  /** receipt UTXO to hand back (claimWith) */
  receiptUtxo?: SpendableUtxo;
  /** unlocker for the receipt UTXO (defaults to the claimant's P2PKH unlocker) */
  receiptUnlocker?: Unlocker;
  /** claimant-owned BCH-only UTXOs used for fee and dust */
  funding: SpendableUtxo[];
  claimer: Wallet;
  changeAddress?: string;
};

/**
 * Builds a claim transaction:
 *   in  0: pool reward tokens     in  1: pool state NFT
 *   in  2: receipt NFT (claimWith only), then claimant funding
 *   out 0: payout to the leaf address   out 1: pool reward tokens (reduced)
 *   out 2: pool state NFT (new root)    out 3: receipt NFT
 *   out 4: claimant change (no tokens)
 */
export function buildClaim(
  contract: Contract,
  state: PoolState,
  args: ClaimArgs,
  networkProvider = contract.provider,
): TransactionBuilder {
  const { proof } = args;
  const payout = proof.earned - proof.claimed;
  const proofBytes = Buffer.concat(proof.siblings.map((s) => Buffer.from(s, 'hex')));
  const unlockClaim = contract.unlock.claim(
    Buffer.from(proof.addrHash, 'hex'),
    proof.earned,
    proof.claimed,
    proofBytes,
    BigInt(proof.path),
    args.receiptUtxo !== undefined,
  );

  const builder = new TransactionBuilder({ provider: networkProvider });
  builder.addInput(state.rewardUtxo, unlockClaim);
  builder.addInput(state.stateUtxo, unlockClaim);
  if (args.receiptUtxo) builder.addInput(args.receiptUtxo, args.receiptUnlocker ?? args.claimer.unlocker);
  for (const utxo of args.funding) builder.addInput(utxo, args.claimer.unlocker);

  // 0: payout
  builder.addOutput({
    to: args.recipient,
    amount: 1000n,
    token: { category: state.rewardUtxo.token!.category, amount: payout },
  });
  // 1: reward balance back to the pool
  builder.addOutput({
    to: contract.tokenAddress,
    amount: 1000n,
    token: {
      category: state.rewardUtxo.token!.category,
      amount: state.rewardUtxo.token!.amount - payout,
    },
  });
  // 2: state NFT with the rewritten root
  builder.addOutput({
    to: contract.tokenAddress,
    amount: 1000n,
    token: {
      category: state.stateUtxo.token!.category,
      amount: 0n,
      nft: { capability: 'minting', commitment: encodeState(rootAfterClaim(proof), ZERO20) },
    },
  });
  // 3: receipt NFT recording the cumulative claimed total
  builder.addOutput({
    to: args.receiptTo ?? args.recipient,
    amount: 1000n,
    token: {
      category: state.stateUtxo.token!.category,
      amount: 0n,
      nft: { capability: 'none', commitment: `${proof.addrHash}${u64(proof.earned)}` },
    },
  });

  builder.addBchChangeOutputIfNeeded({
    to: args.changeAddress ?? args.claimer.address,
    feeRate: Number(process.env.FC_FEE_RATE ?? '1.1'),
  });
  return builder;
}

function u64(value: bigint): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf.toString('hex');
}

function stateOutput(
  contract: Contract,
  state: PoolState,
  commitment: string,
  amount = 1000n,
): { to: string; amount: bigint; token: { category: string; amount: bigint; nft: { capability: 'minting'; commitment: string } } } {
  return {
    to: contract.tokenAddress,
    amount,
    token: {
      category: state.stateUtxo.token!.category,
      amount: 0n,
      nft: { capability: 'minting', commitment },
    },
  };
}

export function buildPropose(
  contract: Contract,
  state: PoolState,
  newRoot: string,
  operator: Wallet,
  funding: SpendableUtxo[] = [],
  networkProvider = contract.provider,
): TransactionBuilder {
  const builder = new TransactionBuilder({ provider: networkProvider });
  builder.addInput(
    state.stateUtxo,
    contract.unlock.proposeRoot(Buffer.from(newRoot, 'hex'), operator.signer),
  );
  for (const utxo of funding) builder.addInput(utxo, operator.unlocker);
  builder.addOutput(stateOutput(contract, state, encodeState(state.activeRoot, newRoot)));
  builder.addBchChangeOutputIfNeeded({
    to: operator.address,
    feeRate: Number(process.env.FC_FEE_RATE ?? '1.1'),
  });
  return builder;
}

export function buildActivate(
  contract: Contract,
  state: PoolState,
  operator: Wallet,
  sequence: number,
  funding: SpendableUtxo[] = [],
  networkProvider = contract.provider,
): TransactionBuilder {
  const builder = new TransactionBuilder({ provider: networkProvider });
  builder.addInput(state.stateUtxo, contract.unlock.activateRoot(operator.signer), { sequence });
  for (const utxo of funding) builder.addInput(utxo, operator.unlocker);
  builder.addOutput(stateOutput(contract, state, encodeState(state.pendingRoot, ZERO20)));
  builder.addBchChangeOutputIfNeeded({
    to: operator.address,
    feeRate: Number(process.env.FC_FEE_RATE ?? '1.1'),
  });
  return builder;
}

export function buildCancel(
  contract: Contract,
  state: PoolState,
  operator: Wallet,
  funding: SpendableUtxo[] = [],
  networkProvider = contract.provider,
): TransactionBuilder {
  const builder = new TransactionBuilder({ provider: networkProvider });
  builder.addInput(state.stateUtxo, contract.unlock.cancelRoot(operator.signer));
  for (const utxo of funding) builder.addInput(utxo, operator.unlocker);
  builder.addOutput(stateOutput(contract, state, encodeState(state.activeRoot, ZERO20)));
  builder.addBchChangeOutputIfNeeded({
    to: operator.address,
    feeRate: Number(process.env.FC_FEE_RATE ?? '1.1'),
  });
  return builder;
}

// ---------------------------------------------------------------- tree files

export type TreeFile = {
  depth: number;
  epoch: number;
  root: string;
  leaves: { addrHash: string; address: string; earned: string; claimed: string }[];
};

export function loadTree(path = TREE_PATH): TreeFile {
  return JSON.parse(readFileSync(path, 'utf8')) as TreeFile;
}

export function saveTree(file: TreeFile, path = TREE_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

export function treeFromFile(file: TreeFile): MerkleTree {
  return new MerkleTree(
    file.leaves.map((l) => ({ addrHash: l.addrHash, earned: BigInt(l.earned), claimed: BigInt(l.claimed) })),
    file.depth,
  );
}
