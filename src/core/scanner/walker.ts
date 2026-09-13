import { ENS_NAME_RE, ETH_ADDRESS_RE, TRUNCATED_ADDRESS_RE } from '../address';

/**
 * Text-node traversal for identity detection. Read-only: this module never
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
      // Cheapest pre-filter: the shortest candidate ("a.eth") is 6 chars.
      if ((text.nodeValue?.length ?? 0) < 6) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let current = walker.nextNode();
  while (current) {
    if (current.nodeType === Node.TEXT_NODE) yield current as Text;
    current = walker.nextNode();
  }
}

export type CandidateKind = 'address' | 'truncated' | 'name';

export interface RawCandidate {
  node: Text;
  start: number;
  end: number;
  kind: CandidateKind;
  raw: string;
}

/** Find all identity-shaped substrings within one text node.
 *  Validation beyond shape (EIP-55, href recovery, ENS label rules) happens
 *  in the scanner, which can see the DOM context. */
export function scanTextNode(node: Text): RawCandidate[] {
  const text = node.nodeValue ?? '';
  if (text.length < 6) return [];
  const parent = node.parentElement;
  if (parent && isExcludedElement(parent)) return [];

  const out: RawCandidate[] = [];
  for (const m of text.matchAll(ETH_ADDRESS_RE)) {
    if (m.index === undefined) continue;
    out.push({ node, start: m.index, end: m.index + m[0].length, kind: 'address', raw: m[0] });
  }
  for (const m of text.matchAll(TRUNCATED_ADDRESS_RE)) {
    if (m.index === undefined) continue;
    out.push({
      node,
      start: m.index,
      end: m.index + m[0].length,
      kind: 'truncated',
      raw: m[0],
    });
  }
  for (const m of text.matchAll(ENS_NAME_RE)) {
    if (m.index === undefined) continue;
    out.push({ node, start: m.index, end: m.index + m[0].length, kind: 'name', raw: m[0] });
  }
  // Stable order by position so entry grouping is deterministic.
  return out.sort((a, b) => a.start - b.start);
}
