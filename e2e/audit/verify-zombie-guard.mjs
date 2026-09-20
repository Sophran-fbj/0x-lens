/**
 * Verify the zombie-impostor fix in the exact race window the reviewer
 * measured: zombie answers the probe at ~t+50ms while our child is still
 * loading viem (~t+619ms to EADDRINUSE). Self-contained: spawns its own
 * zombie, kills it afterwards.
 */
import { spawn } from 'node:child_process';
import { startMockRpc } from './mock-helpers.mjs';

const zombie = spawn(process.execPath, ['e2e/audit/mock-rpc-server.mjs'], {
  stdio: 'ignore',
});

// wait until the ZOMBIE is listening (its own /__log answers)
let zombieUp = false;
for (let i = 0; i < 50 && !zombieUp; i++) {
  try {
    await fetch('http://127.0.0.1:5178/__log');
    zombieUp = true;
  } catch {
    await new Promise((r) => setTimeout(r, 100));
  }
}
if (!zombieUp) {
  zombie.kill();
  console.log('FAIL: zombie never started — test invalid');
  process.exit(1);
}

// fire startMockRpc immediately: probe will hit the zombie at ~+50ms,
// our doomed child still loading viem — the exact race window.
let verdict;
try {
  const mock = await startMockRpc();
  verdict = 'UNEXPECTED SUCCESS — race NOT fixed';
  mock.stop();
} catch (err) {
  verdict = `THREW AS EXPECTED: ${String(err.message).slice(0, 150)}`;
}
zombie.kill();

// and the normal path must still work once the zombie is gone
await new Promise((r) => setTimeout(r, 400));
let healthy = 'FAIL';
try {
  const mock = await startMockRpc();
  await mock.config([{ id: 'probe', method: 'eth_blockNumber', action: 'result', value: '0x1' }]);
  const log = await mock.log();
  healthy = log.pid && Array.isArray(log.posts) ? `OK (pid ${log.pid})` : 'BAD RESPONSE SHAPE';
  mock.stop();
} catch (err) {
  healthy = `FAIL: ${String(err.message).slice(0, 120)}`;
}

console.log(`race-window: ${verdict}`);
console.log(`normal-path: ${healthy}`);
process.exit(verdict.startsWith('THREW') && healthy.startsWith('OK') ? 0 : 1);
