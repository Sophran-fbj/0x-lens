import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { cardStore, type CardTarget } from './store';
import { HoverCard } from './HoverCard';
import { identityKey } from '@/core/messaging/protocol';

const CARD_WIDTH = 300;
const MARGIN = 8;
const GAP = 8;

/**
 * Viewport-fixed positioning with flip/clamp. The card measures itself after
 * mount and again whenever its content grows (skeleton → data rows), deciding
 * above/below each time.
 */
function useCardPosition(target: CardTarget | null) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!target) {
      setPos(null);
      return;
    }
    const measure = (): void => {
      const el = ref.current;
      if (!el) return;
      const h = el.offsetHeight;
      let top = target.anchorRect.bottom + GAP;
      if (top + h > window.innerHeight - MARGIN) {
        top = Math.max(MARGIN, target.anchorRect.top - GAP - h);
      }
      const left = Math.min(
        Math.max(MARGIN, target.anchorRect.left),
        window.innerWidth - CARD_WIDTH - MARGIN,
      );
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    };

    measure();
    // Rows arrive after mount (async resolve) — re-measure on growth.
    const mo = new MutationObserver(measure);
    if (ref.current) {
      mo.observe(ref.current, { childList: true, subtree: true, characterData: true });
    }
    return () => mo.disconnect();
  }, [target]);

  return { ref, pos };
}

export function CardLayer() {
  const target = useSyncExternalStore(cardStore.subscribe, cardStore.getSnapshot);
  const { ref, pos } = useCardPosition(target);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence>
        {target && (
          <motion.div
            key={identityKey(target.identity)}
            ref={ref}
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 2, scale: 0.99, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            style={{
              position: 'fixed',
              // Render (hidden, off-screen) BEFORE positioning so the ref
              // exists and the card can measure itself — then reveal.
              visibility: pos ? 'visible' : 'hidden',
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width: CARD_WIDTH,
              zIndex: 2147483647,
            }}
          >
            <HoverCard target={target} />
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
