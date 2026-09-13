/**
 * Convert the demo webm files into optimized GIFs under docs/.
 * The longer video is the article/hover segment → docs/hover.gif;
 * the shorter is the panel segment → docs/panel.gif.
 * (Old static ffmpeg: gif concat demuxer is unreliable — two files it is.)
 *   node e2e/convert.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const FFMPEG = require('@ffmpeg-installer/ffmpeg').path;

mkdirSync('docs', { recursive: true });

const durationOf = (file) => {
  try {
    const out = execFileSync(FFMPEG, ['-i', file], { stdio: ['ignore', 'pipe', 'pipe'] })
      .toString();
    return 0; // ffmpeg without output args exits 1 — unreachable, see below
  } catch (e) {
    // -i with no output prints info to stderr and exits 1 — parse it there
    const err = (e.stderr?.toString?.() ?? '');
    const m = err.match(/Duration: (\d+):(\d+):([\d.]+)/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3];
  }
};

const files = readdirSync('e2e/video')
  .filter((f) => f.endsWith('.webm'))
  .map((f) => ({ f, dur: durationOf(`e2e/video/${f}`) }))
  .sort((a, b) => b.dur - a.dur); // longest first

if (files.length < 2) {
  console.error('expected 2 webm files in e2e/video — run `node e2e/demo.mjs` first');
  process.exit(1);
}

const targets = ['docs/hover.gif', 'docs/panel.gif'];
for (let i = 0; i < 2; i++) {
  const { f, dur } = files[i];
  execFileSync(
    FFMPEG,
    [
      '-y',
      '-i', `e2e/video/${f}`,
      '-vf',
      'fps=14,scale=860:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
      '-loop', '0',
      targets[i],
    ],
    { stdio: 'inherit' },
  );
  console.log(
    `wrote ${targets[i]}  (${dur.toFixed(1)}s source, ${(statSync(targets[i]).size / 1024 / 1024).toFixed(2)} MB)`,
  );
}
