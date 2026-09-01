import { BrowserProvider } from 'ethers';

import type { Eip1193Provider } from 'ethers';

/**
 * What kwil duck-types on.
 *
 * kwil's `executeSign` inspects the object it is handed and routes anything
 * carrying `signMessage` through SECP256K1_PERSONAL -- `secp256k1_ep`, EIP-191
 * personal_sign -- which is the first authenticator Branch's `person_keys`
 * table accepts. There is no interface to implement and no registration step;
 * having the method is the whole contract.
 *
 * Note the parameter type. kwil signs arbitrary payload *bytes*, and that
 * `Uint8Array` arm is the entire reason this module exists.
 */
export interface KwilEthSigner {
  signMessage(message: string | Uint8Array): Promise<string>;
}

/**
 * The part of a Privy wallet this adapter uses.
 *
 * Structural rather than imported: depending on `@privy-io/react-auth` would
 * drag a React dependency into a package the Express backend also loads. Any
 * object with these two members works, which also makes the adapter testable
 * without standing up Privy.
 */
export interface PrivyEthereumWallet {
  address: string;
  getEthereumProvider(): Promise<Eip1193Provider>;
}

/**
 * Rule 1, enforced rather than documented.
 *
 * Privy exposes two ways to sign, and only one of them is usable here.
 *
 * `useSignMessage` takes `message: string`. kwil hands the signer raw payload
 * bytes, and a byte sequence that is not valid UTF-8 does not survive being
 * pushed through a string parameter -- it comes back with U+FFFD where the
 * invalid sequences were, so the signature covers different bytes than the
 * transaction does. The node then rejects a signature that looks structurally
 * fine, which is a miserable thing to debug.
 *
 * The EIP-1193 provider path takes the bytes as bytes: ethers hex-encodes them
 * for `personal_sign` and the exact payload is what gets signed.
 *
 * So the adapter accepts a wallet and reaches for the provider itself. A caller
 * cannot hand it a hook result by mistake -- the shape is wrong, and the guard
 * below says why rather than failing later at signature verification.
 */
export async function signerFromPrivyWallet(wallet: PrivyEthereumWallet): Promise<KwilEthSigner> {
  if (typeof wallet?.getEthereumProvider !== 'function') {
    const looksLikeHook = typeof (wallet as unknown as KwilEthSigner)?.signMessage === 'function';
    throw new TypeError(
      looksLikeHook
        ? "Pass the Privy wallet, not a signMessage function. Privy's useSignMessage " +
            'hook takes a string; kwil signs arbitrary bytes, and non-UTF-8 bytes pushed ' +
            'through a string parameter are mangled before they are signed. Use the ' +
            'wallet from useWallets() so the EIP-1193 provider can be used instead.'
        : 'Expected a Privy wallet with getEthereumProvider(). Received: ' +
            Object.prototype.toString.call(wallet)
    );
  }

  const provider = await wallet.getEthereumProvider();

  // The address is passed explicitly rather than taking the provider's first
  // account. A provider may expose several, and signing a listing with the
  // wrong one of a user's wallets resolves to a different person on chain --
  // person_keys maps address to person, so the mistake is silent and the
  // listing simply belongs to somebody else.
  return await new BrowserProvider(provider).getSigner(wallet.address);
}
