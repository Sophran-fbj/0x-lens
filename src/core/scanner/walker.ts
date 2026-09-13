import { ETH_ADDRESS_RE } from '../address';

/**
 * Text-node traversal for address detection. Read-only: this module never
 * mutates the host page's DOM.
 */

// Subtrees we never scan. TEXTAREA/INPUT are excluded both because overlays
// over editable regions are hostile UX and because their "text" is a value,
// not content. SVG/MATH/CANVAS… have no meaningful text layout.
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TITLE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'CANVAS',
  'SVG',
  'MATH',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'VIDEO',
  'AUDIO',
]);

export function isExcludedElement(el: Element): boolean {
  if (SKIP_TAGS.has(el.tagName)) return true;
  // isContentEditable lives on HTMLElement, not Element.
  if (el instanceof HTMLElement && el.isContentEditable) return true; // never highlight inside editors
  return false;
}

/** Yield every scannable text node under `root` (inclusive). */
export function* walkTextNodes(root: Node): Generator<Text> {
  const doc = root.nodeType === Node.DOCUMENT_NODE ? (root as Document) : root.ownerDocument;
  if (!doc) return;

  // SHOW_ELEMENT lets us REJECT (skip subtree of) excluded elements;
  // SHOW_TEXT yields the actual scan targets.
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node: Node): number {
      if (node.nodeType === Node.ELEMENT_NODE) {
        return isExcludedElement(node as Element)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      }
      const text = node as Text;
      // Cheapest pre-filter: a match needs at least `0x` + 40 chars.
      if ((text.nodeValue?.length ?? 0) < 42) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) yield current as Text;
    current = walker.nextNode();
  }
}

export interface RawMatch {
  node: Text;
  start: number;
  end: number;
  raw: string;
}

/** Find all candidate address substrings within one text node. */
export function scanTextNode(node: Text): RawMatch[] {
  const text = node.nodeValue ?? '';
  if (text.length < 42) return [];
  const parent = node.parentElement;
  if (parent && isExcludedElement(parent)) return [];

  const out: RawMatch[] = [];
  // matchAll works on a cloned regex internally — no lastIndex leakage.
  for (const m of text.matchAll(ETH_ADDRESS_RE)) {
    if (m.index === undefined) continue;
    out.push({ node, start: m.index, end: m.index + m[0].length, raw: m[0] });
  }
  return out;
}
