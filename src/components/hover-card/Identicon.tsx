/** Deterministic gradient identicon — no network, no avatar dependency.
 *  FNV-1a over the seed (address or ENS name, lowercased) picks two hues. */

function huePair(seed: string): [number, number] {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return [h % 360, (h >>> 9) % 360];
}

export function Identicon({ seed, size = 34 }: { seed: string; size?: number }) {
  const [h1, h2] = huePair(seed.toLowerCase());
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
