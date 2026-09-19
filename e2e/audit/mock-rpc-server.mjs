/**
 * Deterministic mock Ethereum JSON-RPC server for the nightly audit suites.
 * Listens on 127.0.0.1:5178 (never 5173 = fixture, never 3100).
 *
 * Tests configure behavior per request via the control plane:
 *   POST /__config  { rules: [rule...] }        (replaces all rules)
 *   rule: { id, method, addrSub?, action, value?, delayMs? }
 *     action 'result'        → JSON-RPC result = value
 *     action 'rpcerror'      → JSON-RPC error {code:-32000, message, data?}
 *     action 'status'        → HTTP <value> with an error body
 *     action 'rawbody'       → HTTP 200, non-JSON body
 *     action 'hang'          → never respond (transport timeout path)
 *     action 'delay'         → respond after delayMs with the default result
 *     action 'multicall'     → value.items build a Multicall3 aggregate3 reply
 *     action 'offchainLookup'→ value = gateway URL; returns the CCIP error
 *   addrSub: matches only when JSON(params) contains this substring
 *            (use lowercase hex of a contract/address).
 *   GET /__log     → { posts, gatewayHits }
 *   POST /__reset  → clears rules and log
 */
import http from 'node:http';
import fs from 'node:fs';
import {
  encodeFunctionResult,
  encodeErrorResult,
  toHex,
  stringToHex,
  erc20Abi,
} from 'viem';

const PORT = 5178;
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const UNIVERSAL_RESOLVER = '0x231b0ee14048e9dccd1d247744d114a4eb5e8e63';
// viem 2.56 routes ENS lookups through the v2 universal resolver at
// 0xeeee…eeee. Replays below were captured from real mainnet for an
// address without a reverse record and an unregistered name.
const ENS_V2_RESOLVER = '0xeeeeeeee14d718c2b47d9923deab1335e144eeee';
const REVERSE_UNKNOWN_RESULT = '0x00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a7d635c8de9a58a228aa69353a1699c7cc240dcf0000000000000000000000000000000000000000000000000000000000000000';
const FORWARD_UNKNOWN_RESPONSE = { error: { code: 3, message: 'execution reverted', data: '0x77209fe8000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000150f6d6f636b2d61756469742d6e616d6503657468000000000000000000000000' } };

let rules = [];
const log = { posts: [], gatewayHits: 0 };

const DEFAULTS = {
  eth_chainId: '0x1',
  net_version: '1',
  eth_blockNumber: '0x1',
  eth_getBalance: '0x0',
  eth_getBytecode: '0x',
  eth_getCode: '0x',
  eth_getTransactionCount: '0x0',
  eth_getStorageAt: '0x' + '00'.repeat(32),
  eth_call: '0x',
  eth_gasPrice: '0x3b9aca00',
};

function matchRule(method, params) {
  const s = JSON.stringify(params ?? []).toLowerCase();
  const hit = rules.find(
    (r) => r.method === method &&
      (!r.toSub || s.includes(r.toSub.toLowerCase())) &&
      // strip a leading 0x: calldata embeds addresses WITHOUT the prefix
      (!r.addrSub || s.includes(r.addrSub.toLowerCase().replace(/^0x/, ''))),
  );
  if (process.env.OXL_MOCK_DEBUG) {
    fs.appendFileSync('mock-debug.log', JSON.stringify({
      method,
      s: s.slice(0, 200),
      sLen: s.length,
      matched: hit?.id ?? null,
      rules: rules.map((r) => ({ id: r.id, m: r.method, toSub: r.toSub, addrSub: r.addrSub })),
    }) + '\n');
  }
  return hit;
}

function respond(call) {
  // Real nodes reject malformed addresses before anything else; being
  // permissive here would let invalid identities get "resolved" and cached.
  if ((call.method === 'eth_getBalance' || call.method === 'eth_getCode') &&
      !/^0x[0-9a-fA-F]{40}$/.test(String(call.params?.[0] ?? ''))) {
    return {
      jsonrpc: '2.0',
      id: call.id,
      error: { code: -32602, message: 'invalid address' },
    };
  }
  const rule = matchRule(call.method, call.params);
  if (!rule) {
    return { jsonrpc: '2.0', id: call.id, result: DEFAULTS[call.method] ?? '0x' };
  }
  switch (rule.action) {
    case 'result':
      return { jsonrpc: '2.0', id: call.id, result: rule.value };
    case 'rpcerror': {
      const err = { code: rule.value?.code ?? -32000, message: rule.value?.message ?? 'mock error' };
      if (rule.value?.data !== undefined) err.data = rule.value.data;
      return { jsonrpc: '2.0', id: call.id, error: err };
    }
    case 'status':
      return { __httpStatus: rule.value, __raw: `mock RPC http ${rule.value}` };
    case 'rawbody':
      return { __raw: rule.value ?? 'this is not json at all' };
    case 'hang':
      return { __hang: true };
    case 'delay':
      return {
        __delayMs: rule.delayMs ?? 0,
        jsonrpc: '2.0',
        id: call.id,
        result: DEFAULTS[call.method] ?? '0x',
      };
    case 'multicall':
      return {
        jsonrpc: '2.0',
        id: call.id,
        result: encodeMulticall(rule.value?.items ?? []),
      };
    case 'offchainLookup':
      return {
        jsonrpc: '2.0',
        id: call.id,
        error: {
          code: -32000,
          message: 'OffchainLookup',
          data: encodeOffchainLookup(rule.value ?? 'http://127.0.0.1:5178/gateway/{data}'),
        },
      };
    default:
      return { jsonrpc: '2.0', id: call.id, result: DEFAULTS[call.method] ?? '0x' };
  }
}

function encodeMulticall(items) {
  const parts = items.map((it) => {
    const returnData = it.ok
      ? encodeFunctionResult({
          abi: erc20Abi,
          functionName: it.kind === 'decimals' ? 'decimals' : it.kind === 'symbol' ? 'symbol' : 'name',
          result: it.kind === 'decimals' ? it.value : it.value,
        })
      : '0x';
    return [it.ok === true, returnData];
  });
  return encodeFunctionResult({
    abi: [{
      type: 'function',
      name: 'aggregate3',
      inputs: [{ type: 'tuple[]', components: [{ type: 'bool' }, { type: 'bytes' }] }],
      outputs: [{ type: 'tuple[]', components: [{ type: 'bool' }, { type: 'bytes' }] }],
    }],
    functionName: 'aggregate3',
    result: parts,
  });
}

function encodeOffchainLookup(gatewayUrl) {
  const { data } = encodeErrorResult({
    abi: [{
      type: 'error',
      name: 'OffchainLookup',
      inputs: [
        { type: 'address' }, { type: 'string[]' }, { type: 'bytes' },
        { type: 'bytes4' }, { type: 'bytes' },
      ],
    }],
    errorName: 'OffchainLookup',
    args: [
      UNIVERSAL_RESOLVER,
      [gatewayUrl],
      '0x1234',
      '0x12345678',
      '0x',
    ],
  });
  return data;
}

const server = http.createServer((req, res) => {
  if (req.url === '/__config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      rules = JSON.parse(body).rules ?? [];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"rules":' + rules.length + '}');
    });
    return;
  }
  if (req.url === '/__reset' && req.method === 'POST') {
    rules = [];
    log.posts = [];
    log.gatewayHits = 0;
    res.writeHead(200);
    res.end('{"ok":true}');
    return;
  }
  if (req.url === '/__log') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // pid = identity proof: the suites' readiness probe compares it with
    // the pid of the child THEY spawned, so a zombie server from a previous
    // crashed run can never be configured by mistake.
    res.end(JSON.stringify({ pid: process.pid, ...log }));
    return;
  }
  if (req.url?.startsWith('/gateway/')) {
    log.gatewayHits++;
    res.writeHead(200);
    res.end('gateway should never be called (ccipRead is off)');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    log.posts.push({ ts: Date.now(), body });
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end('bad json');
      return;
    }
    const calls = Array.isArray(parsed) ? parsed : [parsed];
    const postIdx = log.posts.length - 1;
    const out = calls.map((call) => {
      if (!matchRule(call.method, call.params) && call.method === 'eth_call') {
        const to = String(call.params?.[0]?.to ?? '').toLowerCase();
        const data = String(call.params?.[0]?.data ?? '').toLowerCase();
        if (to === MULTICALL3) {
          return { jsonrpc: '2.0', id: call.id, result: encodeMulticall([{ ok: false }, { ok: false }, { ok: false }]) };
        }
        if (to === ENS_V2_RESOLVER && data.startsWith('0xb7d6ca64')) {
          // reverseWithGateways for an unknown address → empty reverse record
          return { jsonrpc: '2.0', id: call.id, result: REVERSE_UNKNOWN_RESULT };
        }
        if (to === ENS_V2_RESOLVER && data.startsWith('0xa1472844')) {
          // forward lookup of an unregistered name → resolver revert
          return { jsonrpc: '2.0', id: call.id, ...FORWARD_UNKNOWN_RESPONSE };
        }
      }
      return respond(call);
    });
    if (out.some((o) => o.__hang)) return; // never respond
    const delayed = out.filter((o) => o.__delayMs);
    const send = () => {
      // HTTP-layer rule hits (status / rawbody) apply to the WHOLE POST:
      // real servers answer the request, not individual batch items, so the
      // suites must see a true HTTP 4xx/5xx or non-JSON body — never a
      // JSON batch containing malformed items.
      const httpStatus = out.find((o) => o.__httpStatus !== undefined)?.__httpStatus;
      const rawBody = out.find((o) => o.__raw !== undefined)?.__raw;
      if (httpStatus !== undefined) {
        res.writeHead(httpStatus, { 'content-type': 'text/plain' });
        res.end(rawBody ?? `mock RPC http ${httpStatus}`);
        if (postIdx >= 0) log.posts[postIdx].res = `HTTP ${httpStatus}`;
        return;
      }
      if (rawBody !== undefined) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(rawBody);
        if (postIdx >= 0) log.posts[postIdx].res = 'non-JSON body';
        return;
      }
      const clean = (o) => {
        const { __delayMs, __hang, __httpStatus, __raw, ...rest } = o;
        return rest;
      };
      const final = (Array.isArray(parsed) ? out.map(clean) : clean(out[0]));
      res.writeHead(200, { 'content-type': 'application/json' });
      const outText = JSON.stringify(final);
      if (postIdx >= 0) log.posts[postIdx].res = outText.slice(0, 3000);
      res.end(outText);
    };
    if (delayed.length > 0) {
      setTimeout(send, Math.max(...delayed.map((d) => d.__delayMs)));
    } else {
      send();
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-rpc] listening on http://127.0.0.1:${PORT}/rpc`);
});
