import type { Address } from '@/core/address';

/** Deterministic gradient identicon — no network, no avatar dependency.
 *  FNV-1a over the lowercase hex picks two hues. */

function huePair(address: string): [number, number] {
  let h = 0x811c9dc5;
  for (let i = 2; i < address.length; i++) {
    h ^= address.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return [h % 360, (h >>> 9) % 360];
}

export function Identicon({ address, size = 34 }: { address: Address; size?: number }) {
  const [h1, h2] = huePair(address.toLowerCase());
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        flexShrink: 0,
        background: `linear-gradient(135deg, hsl(${h1} 65% 52%), hsl(${h2} 60% 34%))`,
        boxShadow: 'inset 0 0 0 1px rgba(148, 163, 184, 0.35)',
      }}
      aria-hidden
    />
  );
}
