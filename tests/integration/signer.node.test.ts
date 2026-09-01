import { KwilSigner, NodeKwil } from '@trufnetwork/kwil-js';
import { Wallet, getBytes } from 'ethers';
import { beforeAll, describe, expect, it } from 'vitest';

import { signerFromPrivyWallet } from '../../src/index.js';

import type { Eip1193Provider } from 'ethers';

/**
 * The half of Rule 1 that a fake provider cannot prove.
 *
 * src/signer.test.ts shows the adapter hands the exact payload bytes to the
 * wallet. It cannot show that what comes back is a signature Branch accepts,
 * because its provider returns a canned one. Only a node can answer that, and
 * a signature that is well-formed but computed over the wrong bytes fails in
 * precisely the same place as one computed correctly -- at verification, with
 * an unhelpful message.
 *
 * The provider below is an EIP-1193 shim over a local key. That is what a
 * Privy embedded wallet is from this code's point of view: an object that
 * answers `personal_sign` with hex data. The adapter takes the identical path
 * either way, so what this proves about the signature holds for Privy too.
 * What it does not prove is that Privy's provider behaves as documented; that
 * is the browser wiring in W4.
 *
 * Skipped, not failed, when no node is reachable -- `npm test` stays offline.
 * Run against a live node with `npm run test:integration`.
 */

// Defaults to localhost, which works when WSL's localhostForwarding is
// behaving. When it is not, pass the distro's own address instead --
// BRANCH_PROVIDER=http://<wsl-ip>:8484. See E:\kwil-infra\RUNBOOK.md.
const PROVIDER = process.env.BRANCH_PROVIDER ?? 'http://127.0.0.1:8484';

// An explicitly configured provider that cannot be reached is a failure, not a
// skip. Only the default is allowed to be absent -- otherwise a typo in
// BRANCH_PROVIDER, or a node that died mid-run, reports green and the suite
// quietly stops testing anything.
const EXPLICIT = process.env.BRANCH_PROVIDER !== undefined;

let chainId = '';
let reachable = false;
let reason = '';

/**
 * kwil speaks JSON-RPC at /rpc/v1. There is no REST chain_info endpoint -- every
 * path under /api/v1 returns 404, which is a confusing way to be told you are
 * talking the wrong protocol rather than to the wrong node.
 */
async function chainInfo(): Promise<string> {
  const res = await fetch(`${PROVIDER}/rpc/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'user.chain_info', params: {} }),
  });
  if (!res.ok) throw new Error(`rpc returned ${String(res.status)}`);
  const body = (await res.json()) as { result?: { chain_id?: string } };
  const id = body.result?.chain_id;
  if (!id) throw new Error(`no chain_id in ${JSON.stringify(body)}`);
  return id;
}

/**
 * An EIP-1193 provider backed by a local key, answering the three methods
 * ethers asks of a browser wallet. `personal_sign` takes hex data and signs
 * the bytes it decodes to, which is exactly what a Privy embedded wallet does.
 */
function eip1193(wallet: Wallet): Eip1193Provider {
  return {
    request({ method, params }): Promise<unknown> {
      const args = (params ?? []) as unknown[];
      switch (method) {
        case 'eth_chainId':
          return Promise.resolve('0x1');
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return Promise.resolve([wallet.address]);
        case 'personal_sign':
          return wallet.signMessage(getBytes(args[0] as string));
        default:
          return Promise.reject(new Error(`unexpected method ${method}`));
      }
    },
  };
}

beforeAll(async () => {
  try {
    chainId = await chainInfo();
    reachable = true;
  } catch (err) {
    reachable = false;
    reason = err instanceof Error ? err.message : String(err);
  }
});

/** Returns true when the body should run; throws when a set provider is down. */
function requireNode(): boolean {
  if (reachable) return true;
  if (EXPLICIT) {
    throw new Error(
      `BRANCH_PROVIDER is set to ${PROVIDER} but no Branch node answered there: ${reason}`
    );
  }
  console.warn(`no Branch node at ${PROVIDER} -- skipping (set BRANCH_PROVIDER to require it)`);
  return false;
}

describe.runIf(!process.env.SKIP_INTEGRATION)('a signature made through the adapter', () => {
  it('is accepted by the node', async () => {
    if (!requireNode()) return;

    // A fresh key every run, so `register` always has a new address to claim
    // and the test is idempotent against a long-lived chain. person_keys
    // uniqueness is global and permanent, so reusing one would pass once.
    const wallet = Wallet.createRandom();
    const provider = eip1193(wallet as unknown as Wallet);

    const signer = await signerFromPrivyWallet({
      address: wallet.address,
      getEthereumProvider: () => Promise.resolve(provider),
    });

    const kwil = new NodeKwil({ kwilProvider: PROVIDER, chainId });
    const kwilSigner = new KwilSigner(signer, wallet.address);

    const res = await kwil.execute(
      {
        namespace: 'main',
        name: 'register',
        inputs: [{ $display_name: 'Signer Adapter Integration' }],
      },
      kwilSigner,
      true
    );

    // A rejected signature never reaches an on-chain result, so a code of 0 is
    // the acceptance this test exists to prove.
    expect(res.data?.tx_hash).toBeTruthy();
    expect(res.status).toBe(200);
  }, 60_000);

  it('resolves the caller to the person it registered', async () => {
    if (!requireNode()) return;

    const wallet = Wallet.createRandom();
    const provider = eip1193(wallet as unknown as Wallet);
    const signer = await signerFromPrivyWallet({
      address: wallet.address,
      getEthereumProvider: () => Promise.resolve(provider),
    });

    const kwil = new NodeKwil({ kwilProvider: PROVIDER, chainId });
    const kwilSigner = new KwilSigner(signer, wallet.address);

    await kwil.execute(
      { namespace: 'main', name: 'register', inputs: [{ $display_name: 'Whoami Probe' }] },
      kwilSigner,
      true
    );

    // whoami reads @caller, which is the address recovered from the signature.
    // If the bytes signed were not the bytes sent, this resolves to nobody --
    // which is the exact failure mode Rule 1 guards against, and the reason
    // this assertion is worth more than the tx_hash above.
    const who = await kwil.call({ namespace: 'main', name: 'whoami', inputs: [] }, kwilSigner);

    expect(who.data?.result).toBeTruthy();
  }, 60_000);
});
