/**
 * Error hygiene across the message boundary.
 *
 * Raw viem/RPC errors can embed the full RPC URL — with API keys in the path
 * for Alchemy-style endpoints. The hover card renders into an OPEN shadow
 * root that host-page scripts can read, so only stable codes ever cross.
 */

export type LensErrorCode =
  | 'RPC_TIMEOUT'
  | 'RPC_UNREACHABLE'
  | 'LOOKUP_FAILED'
  | 'NAME_NOT_FOUND';

/** Internal sentinel for "resolvable-looking identity that isn't on chain"
 *  (e.g. an unregistered ENS name) — surfaces to the UI as an empty state. */
export class LensError extends Error {
  constructor(public readonly code: LensErrorCode) {
    super(code);
  }
}

/** Stable code for anything crossing the protocol boundary. */
export function toErrorCode(err: unknown): LensErrorCode {
  if (err instanceof LensError) return err.code;
  const name = err instanceof Error ? err.name : '';
  const msg = err instanceof Error ? err.message : String(err);
  if (name === 'TimeoutError' || /timeout/i.test(msg)) return 'RPC_TIMEOUT';
  if (/fetch failed|network|ENOTFOUND|ECONNREFUSED|ERR_NAME/i.test(msg)) return 'RPC_UNREACHABLE';
  return 'LOOKUP_FAILED';
}

/** Console-safe rendering of a raw error: URL-stripped, key-safe. */
export function redactError(err: unknown): string {
  const s = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return s.replace(/https?:\/\/\S+/g, '<url>');
}

/** Human copy per code, shared by the hover card and the side panel. */
export const ERROR_COPY: Record<LensErrorCode, string> = {
  RPC_TIMEOUT: 'RPC timeout',
  RPC_UNREACHABLE: 'RPC unreachable',
  LOOKUP_FAILED: 'Lookup failed',
  NAME_NOT_FOUND: 'Unregistered name',
};
