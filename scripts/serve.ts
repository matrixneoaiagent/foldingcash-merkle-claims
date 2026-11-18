/**
 * Proof-serving endpoint + watcher (single file, no dependencies).
 *
 *   GET /                     pool summary: root, epoch, audit status, balances
 *   GET /proof/<address>      current Merkle proof for an address
 *   GET /proofs               every proof against the current root (demo convenience)
 *   GET /watch                watcher verdict: does the committed root follow from
 *                             the published leaves + the claims replayed from chain?
 *
 * The server rebuilds the live tree on every request from (a) the published leaf
 * snapshot of the active epoch and (b) the claim history it decodes from the pool
 * address' on-chain transactions, so it never has to trust a local mutable
 * database for correctness — only for caching.
 *
 * Usage: tsx scripts/serve.ts [port] [epoch]
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDeployment, loadTree, poolContract, provider, readPool, ZERO20 } from '../src/pool';
import { applyClaims, claimHistory } from '../src/sync';
import { addrHashOfAddress } from '../src/cash';
import { MerkleTree, verifyProof, type Leaf } from '../src/merkle';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8710);
const requestedEpoch = Number(process.argv[3] ?? 0);
const deployment = loadDeployment();
const providerInstance = provider();
const contract = poolContract(deployment, providerInstance);

type Snapshot = {
  epoch: number;
  root: string;
  depth: number;
  tree: MerkleTree;
  state: { activeRoot: string; pendingRoot: string; balance: bigint };
  claims: Awaited<ReturnType<typeof claimHistory>>;
  watchedAt: string;
  ok: boolean;
};

let cache: Snapshot | undefined;
let cacheAt = 0;

type Published = {
  depth: number;
  epoch: number;
  root: string;
  leaves: { addrHash: string; address: string; earned: string; claimed: string }[];
};

function publishedSnapshots(): Published[] {
  const candidates: Published[] = [];
  for (let i = 1; i <= 999; i += 1) {
    try {
      candidates.push(JSON.parse(readFileSync(resolve(`demo/epochs/epoch-${i}.published.json`), 'utf8')) as Published);
    } catch {
      /* no such epoch */
    }
  }
  return candidates;
}

/**
 * The live epoch is the published leaf set which, with the claims replayed from
 * chain, reproduces the root that is actually committed on-chain. That is the
 * same check the watcher endpoint publishes.
 */
function identifyEpoch(
  activeRoot: string,
  claims: Awaited<ReturnType<typeof claimHistory>>,
): { published: Published; tree: MerkleTree } {
  const candidates = publishedSnapshots().filter((c) => !requestedEpoch || c.epoch === requestedEpoch);
  let fallback: { published: Published; tree: MerkleTree } | undefined;
  for (const candidate of candidates.reverse()) {
    const tree = applyClaims(
      candidate.leaves.map((l): Leaf => ({ addrHash: l.addrHash, earned: BigInt(l.earned), claimed: BigInt(l.claimed) })),
      claims,
      candidate.depth,
    );
    if (!fallback) fallback = { published: candidate, tree };
    if (tree.root === activeRoot) return { published: candidate, tree };
  }
  if (!fallback) throw new Error('no published epoch snapshots found');
  return fallback;
}

async function refresh(force = false): Promise<Snapshot> {
  if (!force && cache && Date.now() - cacheAt < 15_000) return cache;
  const stateNow = await readPool(contract, deployment);
  const claims = await claimHistory(deployment);
  const { published, tree } = identifyEpoch(stateNow.activeRoot, claims);
  const epoch = published.epoch;
  const state = stateNow;
  cache = {
    epoch,
    root: tree.root,
    depth: published.depth,
    tree,
    state: { activeRoot: state.activeRoot, pendingRoot: state.pendingRoot, balance: state.rewardUtxo.token!.amount },
    claims,
    watchedAt: new Date().toISOString(),
    ok: tree.root === state.activeRoot,
  };
  cacheAt = Date.now();
  return cache;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(`${JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  };
  try {
    const snapshot = await refresh();
    if (url.pathname === '/') {
      json(200, {
        contract: contract.address,
        tokenAddress: contract.tokenAddress,
        rewardCategory: deployment.rewardCategory,
        receiptCategory: deployment.receiptCategory,
        epoch: snapshot.epoch,
        root: snapshot.root,
        depth: snapshot.depth,
        leaves: snapshot.tree.size,
        claimsApplied: snapshot.claims.length,
        activeRoot: snapshot.state.activeRoot,
        pendingRoot: snapshot.state.pendingRoot === ZERO20 ? null : snapshot.state.pendingRoot,
        claimsPaused: snapshot.state.pendingRoot !== ZERO20,
        rewardBalance: snapshot.state.balance,
        watcher: snapshot.ok ? 'root matches chain' : 'MISMATCH',
        at: snapshot.watchedAt,
      });
      return;
    }
    if (url.pathname === '/watch') {
      json(snapshot.ok ? 200 : 409, {
        ok: snapshot.ok,
        publishedEpoch: snapshot.epoch,
        recomputedRoot: snapshot.root,
        onChainActiveRoot: snapshot.state.activeRoot,
        claimsApplied: snapshot.claims.length,
        at: snapshot.watchedAt,
      });
      return;
    }
    if (url.pathname === '/proofs') {
      json(200, {
        root: snapshot.root,
        depth: snapshot.depth,
        proofs: publishedAddresses(snapshot).map((address) => {
          const proof = snapshot.tree.proof(addrHashOfAddress(address));
          return { address, ...proof, earned: proof.earned.toString(), claimed: proof.claimed.toString() };
        }),
      });
      return;
    }
    if (url.pathname.startsWith('/proof/')) {
      const address = decodeURIComponent(url.pathname.slice('/proof/'.length));
      const proof = snapshot.tree.proof(addrHashOfAddress(address));
      const valid = verifyProof(proof, snapshot.state.activeRoot);
      json(valid ? 200 : 409, {
        address,
        root: snapshot.state.activeRoot,
        claimable: proof.earned - proof.claimed,
        proof: {
          addrHash: proof.addrHash,
          earned: proof.earned.toString(),
          claimed: proof.claimed.toString(),
          siblings: proof.siblings,
          path: proof.path,
        },
        valid,
      });
      return;
    }
    json(404, { error: 'not found — try /, /watch, /proofs, /proof/<address>' });
  } catch (error) {
    json(500, { error: (error as Error).message });
  }
});

function publishedAddresses(snapshot: Snapshot): string[] {
  const published = JSON.parse(
    readFileSync(resolve(`demo/epochs/epoch-${snapshot.epoch}.published.json`), 'utf8'),
  ) as { leaves: { address: string }[] };
  return published.leaves.map((leaf) => leaf.address);
}

server.listen(port, () => {
  console.log(`proof server on http://localhost:${port}`);
  console.log(`  contract ${contract.address}`);
  console.log(`  epoch is auto-detected from the on-chain active root, ${2 ** Number(process.env.FC_DEPTH ?? 9)} proof slots`);
  console.log('  routes: /  /watch  /proofs  /proof/<address>');
});
