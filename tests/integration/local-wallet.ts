import { Wallet, getBytes } from 'ethers';

import { signerFromPrivyWallet } from '../../src/index.js';

import type { Eip1193Provider } from 'ethers';
import type { KwilEthSigner } from '../../src/index.js';

/**
 * A local key behind an EIP-1193 provider.
 *
 * From the SDK's point of view this is indistinguishable from a Privy embedded
 * wallet: an object that answers `personal_sign` with hex data. Tests that
 * need an identity use this rather than a canned signature, so the whole path
 * -- adapter, kwil signer, node -- is exercised.
 *
 * `signer.node.test.ts` deliberately keeps its own copy. There the shim is the
 * subject under test, and sharing it would mean a change made for this file's
 * convenience could quietly weaken that one.
 */
export interface LocalWallet {
  address: string;
  signer: KwilEthSigner;
}

/**
 * Hardhat's second deterministic account, which migration 90 seeds as the CNMI
 * Central operator and appoints to the credit-issuer office. Public and
 * well-known -- it is the same key branch's own e2e harness uses, and the
 * bootstrap carries a note that it must be replaced before a production chain.
 */
export const OPERATOR_KEY = '59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

export async function localWallet(privateKey?: string): Promise<LocalWallet> {
  const wallet = privateKey === undefined ? Wallet.createRandom() : new Wallet(privateKey);

  const provider: Eip1193Provider = {
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

  const signer = await signerFromPrivyWallet({
    address: wallet.address,
    getEthereumProvider: () => Promise.resolve(provider),
  });

  return { address: wallet.address, signer };
}
