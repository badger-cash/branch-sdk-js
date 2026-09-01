# branch-sdk-js

JavaScript/TypeScript SDK for [Branch](https://github.com/badger-cash/branch)
nodes. JavaScript first, because the web client needs it first.

> **Status: scaffolded.** The toolchain is in place and the clients are not.
> This README records what the package is for and the two rules that are
> expensive to get wrong.

## What it does

Wraps a Branch node's action surface — identity, credits, listings — behind a
typed client, over `@trufnetwork/kwil-js`.

## Signing

kwil's Ethereum signer is duck-typed to a single method:

```ts
type EthSigner = { signMessage: (message: string | Uint8Array) => Promise<string> }
```

Anything carrying that method is routed through `SECP256K1_PERSONAL` —
`secp256k1_ep`, EIP-191 personal_sign — which is the first authenticator
Branch's `person_keys` table accepts.

With Privy that means:

```ts
const provider = await wallet.getEthereumProvider();      // EIP-1193
const signer   = await new BrowserProvider(provider).getSigner();
```

**Rule 1 — sign through the EIP-1193 provider, never through Privy's
`useSignMessage` hook.** The hook takes `message: string`; kwil signs arbitrary
payload *bytes*. Non-UTF-8 bytes pushed through a string parameter are mangled.
`personal_sign` over hex data, and ethers' `signMessage(Uint8Array)` which
prefixes with the byte length, both handle it correctly.

The SDK does this for you:

```ts
import { signerFromPrivyWallet } from '@badger-cash/branch-sdk-js';
import { KwilSigner, WebKwil } from '@trufnetwork/kwil-js';

const signer = await signerFromPrivyWallet(wallet);   // from Privy's useWallets()
const kwil = new WebKwil({ kwilProvider, chainId });
await kwil.execute({ namespace: 'main', name: 'register', inputs: [...] },
                   new KwilSigner(signer, wallet.address), true);
```

It takes the wallet and reaches for the provider itself, so a hook result
cannot be passed by mistake — doing so throws an error naming this problem
rather than failing later at signature verification.

**Rule 2 — normalize every address lookup to `lower(@caller)`.** `@caller` for
an EVM signer is EIP-55 checksummed and therefore mixed case, while
`person_keys.address` is stored canonical lowercase. A bare `address = @caller`
silently matches nothing. This belongs in the SDK so no caller has to remember
it.

It is enforced rather than remembered. `canonicalAddress()` is the only way to
obtain a `CanonicalAddress`, and every lookup takes that type — so a raw
string will not compile:

```ts
import { canonicalAddress } from '@badger-cash/branch-sdk-js';

canonicalAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
// -> '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
```

It also validates. A mixed-case EVM address is checked against its EIP-55
checksum, so a mistyped one is rejected instead of being folded into a
well-formed address for an account nobody holds. `secp256k1` (66 characters)
and `ed25519` (64) are checked for length **and** alphabet — the database
checks only length, which is
[badger-cash/branch#26](https://github.com/badger-cash/branch/issues/26).

## Identity

```ts
import { BranchClient, signerFromPrivyWallet } from '@badger-cash/branch-sdk-js';

const signer = await signerFromPrivyWallet(wallet);
const client = await BranchClient.connect({
  provider: 'https://node.example',       // chainId is read from the node
  address: wallet.address,
  signer,
});

await client.identity.register('Ada Lovelace');
const me = await client.identity.whoami();       // null if this key is nobody
const keys = await client.identity.myKeys();     // pending | active | revoked
```

**Every write reports what actually happened.** kwil compares the committed
result code and throws a bare `Error` whose message is a raw JSON envelope; the
client parses it and rethrows an `ActionFailedError` carrying `action`, `code`,
`log` and `txHash` as fields. A transport failure is left alone and propagates
as itself — one is worth retrying, the other never will be.

**Revocation is permanent.** There is no action that re-enables a revoked key,
and the schema is built so there could not be one: `person_keys` is append-only
history, and rewriting it would silently re-attribute everything the key ever
signed. The address is globally unique and permanent, so a revoked one can
never be registered again by anyone, including its owner. The chain also
refuses to revoke your only active key rather than let you lock yourself out.

## Reads

On-chain data is public and `SELECT` stays granted, so browse and search are
plain queries against the node rather than server-side code. See
`branch/spec/schema/examples/02-listing-queries.sql`.

Brokered fields are different: the chain returns only the custodian's name, and
the plaintext comes from the custodian's API. See
[branch-indexer](https://github.com/badger-cash/branch-indexer).

## Development

```
npm install
npm run check     # typecheck, lint, format:check, test, build
```

Individually: `npm run typecheck`, `npm run lint`, `npm run format`,
`npm test` (`npm run test:watch` while working), `npm run build`.

`npm test` never touches the network. `npm run test:integration` runs the suite
that needs a live node; point it at one with `BRANCH_PROVIDER`, and note that
an explicitly set provider which cannot be reached is a **failure**, not a
skip. Standing a node up is documented in `E:\kwil-infra\RUNBOOK.md`.

The build emits both ESM and CommonJS. That is not hedging: the Vite front end
is ESM and the Express backend is CommonJS, and the backend needs this package
for the server-side `issue_credits` path.

**There is no CI here yet, and that is sequenced rather than forgotten.**
Decision 4 puts CI on the front end first, then on the branch node once the
site is stable. Until then `npm run check` is the gate, run by hand.

## Node 18 is a supported target

**This package runs on Node 18 or higher, and that is a commitment rather
than an accident of what happened to be installed.** Branch is going into
government infrastructure, and government infrastructure upgrades late. A
dependency that quietly needs Node 20 does not fail in CI; it fails on
someone else's server, after install, at the point where the only remedy is
"upgrade your runtime" and the answer is no.

So it is asserted, not assumed. `src/engines.test.ts` walks the whole
production tree from the lockfile -- transitive dependencies included -- and
fails, naming the package, if anything shipped declares a floor above Node
18. The risk is never the dependency chosen deliberately. It is the third one
down that a chosen dependency pulled in.

**Dev dependencies are exempt, and that exemption is what makes the floor
affordable.** ESLint 10, TypeScript 6 and Vitest 4 have all left Node 18
behind, so the toolchain here is held one major back -- ESLint 9, TypeScript
5, Vitest 3. None of it reaches anyone who installs the package. What a
contributor needs to run the linter and what a consumer needs to run the SDK
are different questions, and only the second one is a promise.

Contributing does want Node **18.18+** rather than plain 18.0: several ESLint
packages set their floor there. Consumers are unaffected.

Two consequences worth keeping in view:

- The pins are floors, not ceilings. Every one of them declares support well
  past 18, so running the toolchain on Node 20, 22 or 24 works today. Holding
  18 costs nothing in the other direction.
- Node 18 left upstream support in April 2025. Security patches for the
  runtime are somebody's problem regardless, and supporting it here does not
  make that go away -- it means deployments stuck on 18 get a working SDK
  rather than an install error.

## License

MIT
