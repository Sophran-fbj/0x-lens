/**
 * Phase 2 real-chain validation. Runs the exact viem pipeline used by the
 * background (chain.ts / profile.ts / token.ts semantics) against real
 * Ethereum mainnet and asserts known-good values.
 *
 *   node e2e/rpc.mjs            (uses viem default RPC, like the build)
 *   VITE_RPC_URL=... node e2e/rpc.mjs
 */
import { createPublicClient, erc20Abi, http } from 'viem';
import { mainnet } from 'viem/chains';

const rpcUrl = process.env.VITE_RPC_URL ?? mainnet.rpcUrls.default.http[0];
console.log('RPC endpoint:', rpcUrl);

const client = createPublicClient({
  chain: mainnet,
  transport: http(rpcUrl, { batch: true }),
});

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const UNKNOWN = '0xabcdef0123456789abcdef0123456789abcdef01';

// --- wave 1: identity (the exact Promise.all from profile.ts) -------------
const t0 = Date.now();
const [vitalikBalance, vitalikBytecode, vitalikEns] = await Promise.all([
  client.getBalance({ address: VITALIK }),
  client.getBytecode({ address: VITALIK }),
  client.getEnsName({ address: VITALIK }),
]);
const wave1ms = Date.now() - t0;
console.log(`wave 1 (batched Promise.all): ${wave1ms}ms`);

// Vitalik's account currently carries an EIP-7702 delegation designator —
// either plain EOA or delegated EOA is acceptable, CONTRACT is not. He may
// also revoke the delegation at any time, so don't hardcode the target.
const isEoa = !vitalikBytecode || vitalikBytecode === '0x';
const is7702 =
  vitalikBytecode?.length === 48 && vitalikBytecode.toLowerCase().startsWith('0xef0100');
check(
  'vitalik classified EOA (plain or EIP-7702)',
  isEoa || is7702,
  is7702 ? `7702 → ${'0x' + vitalikBytecode.slice(8)}` : 'plain EOA',
);
check('vitalik has ENS', vitalikEns === 'vitalik.eth', `got ${vitalikEns}`);
check('vitalik balance > 0', vitalikBalance > 0n, `${vitalikBalance} wei`);

// --- wave 2: token probe on USDC (the exact multicall from token.ts) ------
const t1 = Date.now();
const [n, s, d] = await client.multicall({
  allowFailure: true,
  contracts: [
    { address: USDC, abi: erc20Abi, functionName: 'name' },
    { address: USDC, abi: erc20Abi, functionName: 'symbol' },
    { address: USDC, abi: erc20Abi, functionName: 'decimals' },
  ],
});
const wave2ms = Date.now() - t1;
console.log(`wave 2 (token multicall): ${wave2ms}ms`);

check('USDC name', n.status === 'success' && n.result === 'USD Coin', `got ${n.result}`);
check('USDC symbol', s.status === 'success' && s.result === 'USDC', `got ${s.result}`);
check('USDC decimals', d.status === 'success' && d.result === 6, `got ${d.result}`);

// --- negative: unknown EOA -------------------------------------------------
const [unkEns, unkBytecode, unkBalance] = await Promise.all([
  client.getEnsName({ address: UNKNOWN }),
  client.getBytecode({ address: UNKNOWN }),
  client.getBalance({ address: UNKNOWN }),
]);
check('unknown addr: no ENS', unkEns === null, `got ${unkEns}`);
check('unknown addr: EOA', unkBytecode === '0x' || unkBytecode === undefined);
check('unknown addr: zero balance', unkBalance === 0n, `${unkBalance} wei`);

// --- negative: token probe on an EOA must fail cleanly --------------------
const eoaProbe = await client.multicall({
  allowFailure: true,
  contracts: [
    { address: VITALIK, abi: erc20Abi, functionName: 'name' },
    { address: VITALIK, abi: erc20Abi, functionName: 'symbol' },
    { address: VITALIK, abi: erc20Abi, functionName: 'decimals' },
  ],
});
check('EOA token probe fails (→ plain EOA)', eoaProbe.every((r) => r.status !== 'success'));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
