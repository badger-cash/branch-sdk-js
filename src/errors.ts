/** Base for everything this package throws deliberately. */
export class BranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * An action was mined and then failed.
 *
 * kwil does detect this. `broadcastClient` compares the committed result code
 * against zero and throws when it differs -- but it throws a bare `Error`
 * whose message is the raw JSON envelope:
 *
 *     {"tx_hash":"9f79...","result":{"code":65535,"gas":0,
 *      "log":"ERROR: this key is already registered"}}
 *
 * A caller cannot act on that without parsing a string, and cannot tell it
 * apart from a transport failure at all. This type carries the same facts as
 * fields, so "the key is already registered" can be shown to a user while "the
 * node is unreachable" can be retried. Those are not the same situation and
 * should not arrive as the same type.
 */
export class ActionFailedError extends BranchError {
  constructor(
    readonly action: string,
    readonly code: number,
    readonly log: string,
    readonly txHash: string
  ) {
    super(`${action} failed on chain (code ${String(code)}): ${log || '(no log)'}`);
  }
}

/** The node accepted a transaction but told us nothing identifying about it. */
export class UnconfirmedTransactionError extends BranchError {
  constructor(
    readonly action: string,
    reason: string
  ) {
    super(`${action} was submitted but its outcome is unknown: ${reason}`);
  }
}

interface NodeFailure {
  code: number;
  log: string;
  txHash: string;
}

/**
 * Recover the structured result from the error kwil throws.
 *
 * Returns null for anything that is not that envelope -- a DNS failure, a
 * timeout, a 500 -- so those keep propagating as themselves rather than being
 * relabelled as an on-chain refusal.
 */
export function parseNodeFailure(err: unknown): NodeFailure | null {
  if (!(err instanceof Error)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(err.message);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const envelope = parsed as { tx_hash?: unknown; result?: unknown };
  const result = envelope.result;
  if (typeof result !== 'object' || result === null) return null;

  const { code, log } = result as { code?: unknown; log?: unknown };
  if (typeof code !== 'number') return null;

  return {
    code,
    log: typeof log === 'string' ? log : '',
    txHash: typeof envelope.tx_hash === 'string' ? envelope.tx_hash : '',
  };
}
