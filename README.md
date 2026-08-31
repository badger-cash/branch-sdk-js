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

**Rule 2 — normalize every address lookup to `lower(@caller)`.** `@caller` for
an EVM signer is EIP-55 checksummed and therefore mixed case, while
`person_keys.address` is stored canonical lowercase. A bare `address = @caller`
silently matches nothing. This belongs in the SDK so no caller has to remember
it.

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

The build emits both ESM and CommonJS. That is not hedging: the Vite front end
is ESM and the Express backend is CommonJS, and the backend needs this package
for the server-side `issue_credits` path.

**There is no CI here yet, and that is sequenced rather than forgotten.**
Decision 4 puts CI on the front end first, then on the branch node once the
site is stable. Until then `npm run check` is the gate, run by hand.

### The tooling is pinned below latest, deliberately

The workspace runs **Node 18**, which is what the front end's Vite 5 was set
up against. Current ESLint, TypeScript and Vitest majors have moved to Node
20 or 22 minimums, so the devDependencies here are held at the last line that
still runs: ESLint 9, TypeScript 5, Vitest 3.

Do not bump them on their own. Node 18 went out of support in April 2025, so
the runtime is the thing that needs raising, and raising it is a workspace
change -- this package, the front end and the indexer together -- not a
dependency bump in one repo.

## License

MIT
