import { useEffect, useState } from 'react';
import { storage } from 'wxt/utils/storage';
import type { Address } from '@/core/address';
import { requestProfile } from '@/core/messaging/client';
import type { AddressProfile } from '@/core/messaging/protocol';
import { formatEth } from '@/core/format';
import { Identicon } from '@/components/hover-card/Identicon';

/**
 * Side panel — the persistent readout. Address handoff goes through
 * storage.session 'session:lens:focus' (written by the background when
 * openPanel fires), watched here so an already-open panel switches targets.
 */

export default function App() {
  const [address, setAddress] = useState<Address | null>(null);
  const [profile, setProfile] = useState<AddressProfile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);

  // Focus handoff: initial read + live watch.
  useEffect(() => {
    const item = storage.defineItem<Address | null>('session:lens:focus', { fallback: null });
    void item.getValue().then(setAddress);
    const unwatch = item.watch((next) => setAddress(next));
    return unwatch;
  }, []);

  // Resolve through the same message path as the hover card.
  useEffect(() => {
    if (!address) {
      setProfile(null);
      setError(null);
      return;
    }
    let alive = true;
    setProfile(null);
    setError(null);
    requestProfile(address)
      .then((res) => {
        if (!alive) return;
        if (res.ok) setProfile(res.profile);
        else setError(res.error);
      })
      .catch((err) => alive && setError(String(err)));
    return () => {
      alive = false;
    };
  }, [address]);

  // Keep "scanned …s ago" fresh without re-fetching.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const copy = async (): Promise<void> => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard denied — ignore */
    }
  };

  return (
    <main className="flex h-screen flex-col font-mono text-[12px] text-lens-text">
      {!address ? (
        <EmptyPanel />
      ) : (
        <>
          <header className="flex items-center gap-3 border-b border-lens-border px-4 py-4">
            <Identicon address={address} size={40} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold">
                {profile?.ensName ?? 'Unknown account'}
              </div>
              <div className="mt-0.5 break-all text-[10px] leading-relaxed text-lens-dim">
                {address}
              </div>
            </div>
            <button
              type="button"
              onClick={copy}
              aria-label="Copy address"
              className="shrink-0 rounded border border-lens-border px-2 py-1 text-[9px] tracking-[0.15em] text-lens-dim transition-colors hover:border-lens-accent-dim hover:text-lens-accent"
            >
              {copied ? 'COPIED' : 'COPY'}
            </button>
          </header>

          {error ? (
            <section className="px-4 py-6 text-[10px] tracking-[0.12em] text-red-400">
              LOOKUP FAILED
              <div className="mt-2 normal-case tracking-normal text-lens-dim">{error}</div>
            </section>
          ) : !profile ? (
            <SkeletonRows />
          ) : (
            <section className="flex flex-col gap-3 px-4 py-4">
              <Row label="BALANCE" value={`${formatEth(profile.ethBalanceWei)} ETH`} />
              <Row
                label="TYPE"
                value={
                  <span className="rounded border border-lens-accent-dim px-2 py-0.5 text-[10px] tracking-[0.12em] text-lens-accent">
                    {typeLabel(profile)}
                  </span>
                }
              />
              {profile.tokenMetadata && (
                <Row
                  label="TOKEN"
                  value={`${profile.tokenMetadata.name} · ${profile.tokenMetadata.symbol}`}
                />
              )}
              {profile.eoaDelegation && (
                <Row label="DELEGATE" value={profile.eoaDelegation} mono />
              )}
            </section>
          )}

          <footer className="mt-auto border-t border-lens-border px-4 py-3">
            <a
              href={`https://etherscan.io/address/${address}`}
              target="_blank"
              rel="noreferrer"
              className="block rounded border border-lens-accent-dim bg-lens-accent/5 py-2 text-center text-[10px] tracking-[0.2em] text-lens-accent transition-colors hover:bg-lens-accent/15"
            >
              VIEW ON ETHERSCAN ↗
            </a>
            <div className="mt-3 flex items-center gap-2 text-[9px] tracking-[0.18em] text-lens-dim">
              <span className="h-[5px] w-[5px] rounded-full bg-lens-accent-dim" />
              ETHEREUM MAINNET
              {profile && <span className="ml-auto">scanned {ago(profile.fetchedAt)}</span>}
            </div>
          </footer>
        </>
      )}
    </main>
  );
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="shrink-0 text-[10px] tracking-[0.14em] text-lens-dim">{label}</span>
      <span className={`truncate text-[11px] ${mono ? '' : 'text-right'}`}>{value}</span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <section className="flex flex-col gap-3 px-4 py-4">
      {[58, 42, 66].map((w) => (
        <div key={w} className="h-[10px] animate-pulse rounded bg-lens-border/40" style={{ width: `${w}%` }} />
      ))}
    </section>
  );
}

function EmptyPanel() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="text-[11px] tracking-[0.3em] text-lens-dim">0X LENS</div>
      <p className="text-[10px] leading-relaxed tracking-[0.08em] text-lens-dim">
        Hover any Ethereum address on any page.
        <br />
        Click it — or OPEN LENS — to read it here.
      </p>
    </div>
  );
}

function typeLabel(p: AddressProfile): string {
  if (!p.isContract) return p.eoaDelegation ? 'EOA · 7702' : 'EOA';
  return p.tokenMetadata ? 'TOKEN' : 'CONTRACT';
}

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}
