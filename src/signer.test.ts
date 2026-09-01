import { KwilSigner } from '@trufnetwork/kwil-js';
import { hexlify, toUtf8Bytes } from 'ethers';
import { describe, expect, it } from 'vitest';

import { signerFromPrivyWallet } from './signer.js';

import type { Eip1193Provider } from 'ethers';
import type { PrivyEthereumWallet } from './signer.js';

// Hardhat account #0, checksummed as a real provider would return it.
const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const OTHER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const FAKE_SIGNATURE = '0x' + '11'.repeat(65);

interface Recorded {
  method: string;
  params: unknown[];
}

/** An EIP-1193 provider that records what it was asked to sign. */
function fakeProvider(accounts: string[] = [ADDRESS]): {
  provider: Eip1193Provider;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const provider: Eip1193Provider = {
    request({ method, params }): Promise<unknown> {
      const args = (params ?? []) as unknown[];
      calls.push({ method, params: args });
      switch (method) {
        case 'eth_chainId':
          return Promise.resolve('0x1');
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return Promise.resolve(accounts);
        case 'personal_sign':
          return Promise.resolve(FAKE_SIGNATURE);
        default:
          return Promise.reject(new Error(`unexpected method ${method}`));
      }
    },
  };
  return { provider, calls };
}

function fakeWallet(accounts?: string[]): {
  wallet: PrivyEthereumWallet;
  calls: Recorded[];
} {
  const { provider, calls } = fakeProvider(accounts);
  return {
    wallet: {
      address: ADDRESS,
      getEthereumProvider: () => Promise.resolve(provider),
    },
    calls,
  };
}

describe('signerFromPrivyWallet', () => {
  it('produces something kwil will accept as an EthSigner', async () => {
    const { wallet } = fakeWallet();
    const signer = await signerFromPrivyWallet(wallet);

    // kwil duck-types on this method and nothing else.
    expect(typeof signer.signMessage).toBe('function');
  });

  it('is accepted by kwil where a signer is required', async () => {
    const { wallet } = fakeWallet();
    const signer = await signerFromPrivyWallet(wallet);

    // Both a type check and a runtime one. KwilSigner's first parameter is
    // kwil's own EthSigner type, so this failing to compile would mean the
    // adapter no longer satisfies the contract -- which is exactly the
    // breakage a hand-written structural interface can drift into.
    const kwilSigner = new KwilSigner(signer, ADDRESS);

    expect(kwilSigner.signer).toBe(signer);
  });

  it('signs a string payload', async () => {
    const { wallet, calls } = fakeWallet();
    const signer = await signerFromPrivyWallet(wallet);

    await expect(signer.signMessage('hello')).resolves.toBe(FAKE_SIGNATURE);
    const signed = calls.find((c) => c.method === 'personal_sign');
    expect(signed?.params[0]).toBe(hexlify(toUtf8Bytes('hello')));
  });

  /**
   * This is Rule 1, stated as a test.
   *
   * kwil hands the signer a serialized transaction, which is arbitrary bytes
   * and very often not valid UTF-8. The bytes below are deliberately illegal
   * as UTF-8: a bare continuation byte, a truncated two-byte sequence, and an
   * encoded surrogate half.
   */
  const NOT_UTF8 = new Uint8Array([0xff, 0xfe, 0x80, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0x00]);

  it('passes non-UTF-8 payload bytes through byte for byte', async () => {
    const { wallet, calls } = fakeWallet();
    const signer = await signerFromPrivyWallet(wallet);

    await signer.signMessage(NOT_UTF8);

    const signed = calls.find((c) => c.method === 'personal_sign');
    expect(signed).toBeDefined();
    // What actually went to the wallet, hex-encoded by ethers.
    expect(signed?.params[0]).toBe('0xfffe80c328eda08000');
    expect(signed?.params[1]).toBe(ADDRESS.toLowerCase());
  });

  it('shows what the string path would have done to those same bytes', () => {
    // Privy's useSignMessage hook takes `message: string`, so reaching it means
    // decoding the payload first. TextDecoder is not lossless: every illegal
    // sequence becomes U+FFFD, and re-encoding produces different bytes than
    // went in. The signature would then cover a payload the node never sees.
    const throughAString = toUtf8Bytes(new TextDecoder().decode(NOT_UTF8));

    expect(hexlify(throughAString)).not.toBe(hexlify(NOT_UTF8));
    // Not a near miss -- it is longer than the original, and shares no prefix.
    expect(throughAString.length).toBeGreaterThan(NOT_UTF8.length);
  });

  it('signs as the wallet it was given, not the provider default', async () => {
    // A provider offering two accounts must still sign as the wallet passed in.
    // person_keys maps address to person, so signing with the wrong account of
    // the same user resolves to a different person on chain -- silently.
    const { wallet, calls } = fakeWallet([OTHER, ADDRESS]);
    const signer = await signerFromPrivyWallet(wallet);

    await signer.signMessage('x');

    const signed = calls.find((c) => c.method === 'personal_sign');
    expect(signed?.params[1]).toBe(ADDRESS.toLowerCase());
  });

  describe('refuses the hook path', () => {
    it('rejects a bare signMessage function object and says why', async () => {
      // What a caller reaches for if they wire up Privy's useSignMessage.
      const hookish = { signMessage: () => Promise.resolve('0xdead') };

      await expect(
        signerFromPrivyWallet(hookish as unknown as PrivyEthereumWallet)
      ).rejects.toThrow(/useSignMessage/);
    });

    it('names the real problem, not just the wrong shape', async () => {
      const hookish = { signMessage: () => Promise.resolve('0xdead') };

      await expect(
        signerFromPrivyWallet(hookish as unknown as PrivyEthereumWallet)
      ).rejects.toThrow(/mangled/);
    });

    it('rejects anything else with a usable message', async () => {
      await expect(
        signerFromPrivyWallet(undefined as unknown as PrivyEthereumWallet)
      ).rejects.toThrow(/getEthereumProvider/);
    });
  });
});
