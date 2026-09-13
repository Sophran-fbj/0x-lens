import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import type { AddressProfile } from '@/core/messaging/protocol';
import { openLens, requestProfile } from '@/core/messaging/client';
import { ERROR_COPY, toErrorCode, type LensErrorCode } from '@/core/errors';
import { formatEth, shortenAddress } from '@/core/format';
import type { CardTarget } from './store';
import { cardStore, resolvedAddresses } from './store';
import { Identicon } from './Identicon';

/**
 * The identity readout. Data flows through the real message path
 * (content script → background → RPC); the reveal choreography only renders
 * what has actually arrived — shimmer means "not yet", never fake progress.
 */

const rowVariants = {
  hidden: { opacity: 0, y: 4 },
  visible: { opacity: 1, y: 0 },
};

export function HoverCard({ target }: { target: CardTarget }) {
  const [profile, setProfile] = useState<AddressProfile | null>(null);
  const [error, setError] = useState<LensErrorCode | null>(null);
  const isName = !target.identity.startsWith('0x');

  useEffect(() => {
    let alive = true;
    setProfile(null);
    setError(null);
    requestProfile(target.identity)
      .then((res) => {
        if (!alive) return;
        if (res.ok) {
          setProfile(res.profile);
          resolvedAddresses.add(target.identity);
        } else {
          setError(res.error);
        }
      })
      .catch((err) => {
        if (alive) setError(toErrorCode(err));
      });
    return () => {
      alive = false;
    };
  }, [target.identity]);

  // Slow path: rows stagger in from hidden. Fast (already-scanned) path:
  // render them immediately — no repeated ceremony.
  const stagger = { hidden: {}, visible: { transition: { staggerChildren: 0.045 } } };

  // Header: names show themselves; addresses show ENS or the truncation.
  const displayName = isName ? target.identity : (profile?.ensName ?? shortenAddress(target.identity));

  return (
    <div className="oxl-card" role="tooltip">
      <div className="oxl-head">
        <Identicon seed={profile?.address ?? target.identity} />
        <div style={{ minWidth: 0 }}>
          <div className="oxl-name">{displayName}</div>
          <div className="oxl-sub">{profile ? shortenAddress(profile.address) : 'resolving…'}</div>
        </div>
      </div>

      {error === 'NAME_NOT_FOUND' ? (
        <div className="oxl-empty">
          UNREGISTERED NAME
          <span className="oxl-scan-dim" />
          no such name on mainnet
        </div>
      ) : error ? (
        <div className="oxl-empty">
          {ERROR_COPY[error] ?? 'Lookup failed'}
          <span className="oxl-scan-dim" />
          <span className="oxl-err">{error}</span>
        </div>
      ) : !profile ? (
        <div className="oxl-rows">
          <div className="oxl-skel" style={{ width: '58%' }} />
          <div className="oxl-skel" style={{ width: '42%' }} />
          <div className="oxl-skel" style={{ width: '66%' }} />
        </div>
      ) : isEmptyProfile(profile) ? (
        <div className="oxl-empty">
          NO ON-CHAIN FOOTPRINT
          <span className="oxl-scan-dim" />
          no activity on mainnet
        </div>
      ) : (
        <motion.div
          className="oxl-rows"
          variants={stagger}
          initial={target.fast ? 'visible' : 'hidden'}
          animate="visible"
        >
          <motion.div className="oxl-row" variants={rowVariants}>
            <span className="oxl-label">BALANCE</span>
            <span className="oxl-value">{formatEth(profile.ethBalanceWei)} ETH</span>
          </motion.div>
          <motion.div className="oxl-row" variants={rowVariants}>
            <span className="oxl-label">TYPE</span>
            <span className={`oxl-chip${profile.tokenMetadata ? ' is-token' : ''}`}>
              {typeLabel(profile)}
            </span>
          </motion.div>
          {profile.tokenMetadata && (
            <motion.div className="oxl-row" variants={rowVariants}>
              <span className="oxl-label">TOKEN</span>
              <span className="oxl-value">
                {profile.tokenMetadata.name} · {profile.tokenMetadata.symbol}
              </span>
            </motion.div>
          )}
          {profile.eoaDelegation && (
            <motion.div className="oxl-row" variants={rowVariants}>
              <span className="oxl-label">DELEGATE</span>
              <span className="oxl-value">{shortenAddress(profile.eoaDelegation)}</span>
            </motion.div>
          )}
        </motion.div>
      )}

      <div className="oxl-foot">
        <span className="oxl-dot" />
        ETHEREUM MAINNET
      </div>

      {/* GESTURE RULE: openLens sends the message as its first statement —
          keep this handler synchronous up to that call. */}
      <button
        type="button"
        className="oxl-open"
        onClick={() => {
          openLens(target.identity);
          cardStore.hide();
        }}
      >
        OPEN LENS ⌁
      </button>
    </div>
  );
}

function typeLabel(p: AddressProfile): string {
  if (!p.isContract) return p.eoaDelegation ? 'EOA · 7702' : 'EOA';
  return p.tokenMetadata ? 'TOKEN' : 'CONTRACT';
}

function isEmptyProfile(p: AddressProfile): boolean {
  return !p.isContract && !p.ensName && p.ethBalanceWei === '0' && !p.tokenMetadata;
}
