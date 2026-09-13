// Phase 0 placeholder — the real panel (identity header, address + copy,
// balance, token metadata, explorer link) is Phase 4. Tailwind also lands
// there; until then, inline styles only.
export default function App() {
  return (
    <main
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#8b9bb4',
        padding: 16,
      }}
    >
      <p style={{ letterSpacing: '0.2em', margin: 0 }}>0X LENS</p>
      <p style={{ fontSize: 12 }}>side panel · phase 4</p>
    </main>
  );
}
