import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { createReplay, parseLiquidationMessage } from '../replay.mjs';

const startedAt = 1_794_000_000_000;
const levels = [{ price: 100, size: 2 }];
const recordedEvent = { id: 'a', ts: startedAt + 15, side: 'long', price: 99, size: 2 };

async function fixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'tide-lens-replay-test-'));
  const replay = createReplay({ dataDirectory: directory, ...options });
  t.after(async () => {
    await replay.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { replay, directory };
}

async function waitUntil(condition) {
  const limit = Date.now() + 2_000;
  while (!await condition()) {
    if (Date.now() >= limit) assert.fail('Replay data did not finish persisting.');
    await setTimeout(5);
  }
}

test('normalizes official liquidation stream price, executed quantity and sides', () => {
  const binance = { data: { e: 'forceOrder', E: startedAt + 10, st: 1, o: {
    s: 'BTCUSDT', S: 'SELL', T: startedAt + 5, ap: '99', p: '98', z: '0.5', q: '1', l: '0.1',
    X: 'PARTIALLY_FILLED', account: 'private-field',
  } } };
  const [fill] = parseLiquidationMessage('binance', 'BTC', binance);
  assert.equal(fill.side, 'long');
  assert.equal(fill.price, 99);
  assert.equal(fill.size, 0.5);
  assert.equal(fill.notional, 49.5);
  assert.equal(fill.raw.p, '98');
  assert.equal(fill.raw.account, undefined);
  assert.deepEqual(parseLiquidationMessage('binance', 'ETH', binance), []);
  assert.deepEqual(parseLiquidationMessage('binance', 'BTC', { data: { ...binance.data, st: 2 } }), []);
  assert.deepEqual(parseLiquidationMessage('binance', 'BTC', { data: { ...binance.data, o: { ...binance.data.o, z: '0' } } }), []);

  const identical = { s: 'BTCUSDT', S: 'Buy', T: startedAt + 8, v: '2', p: '101' };
  const bybit = parseLiquidationMessage('bybit', 'BTC', {
    topic: 'allLiquidation.BTCUSDT', data: [identical, identical, { ...identical, S: 'Sell' }],
  });
  assert.deepEqual(bybit.map(row => row.side), ['long', 'long', 'short']);
  assert.equal(new Set(bybit.map(row => row.id)).size, 3);
});

test('on-demand recording persists provenance, deduplicates disclosure and scrubs without future records', async t => {
  let polls = 0;
  let time = startedAt;
  const { replay, directory } = await fixture(t, {
    now: () => time,
    intervalMs: 5,
    marketLoader: async () => {
      polls++;
      time = startedAt + polls * 10;
      return {
        book: polls === 2 ? null : { ts: time - 1, bids: levels, asks: [{ price: 100.1, size: 3 }] },
        liquidations: polls >= 2 ? [recordedEvent] : [],
        sources: {
          book: { url: 'https://www.okx.com/', label: 'Official book', method: 'Periodic market snapshot', quality: 'measured' },
          liquidations: { label: 'Official sample', quality: 'measured' },
        },
      };
    },
  });
  assert.deepEqual(await replay.list(), []);
  assert.equal(polls, 0);
  const session = await replay.start({ venue: 'okx', symbol: 'BTC-USDT-SWAP' });
  assert.equal(session.state, 'recording');
  await assert.rejects(replay.start({ venue: 'bybit', symbol: 'BTC' }), /停止/);
  await waitUntil(async () => (await replay.get({ id: session.id })).timeline.length >= 4);
  const stopped = await replay.stop(session.id);
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.firstFrameAt, startedAt + 10);
  assert.equal(stopped.lastEventAt, recordedEvent.ts);

  const fresh = createReplay({ dataDirectory: directory });
  assert.deepEqual(await fresh.list(), [stopped]);
  const before = await fresh.get({ id: session.id, ts: startedAt + 14 });
  assert.equal(before.frame.book.bids[0].notional, 200);
  assert.match(before.frame.sources.book.url, /^https:\/\//);
  assert.deepEqual(before.liquidations, []);
  const at = await fresh.get({ id: session.id, ts: startedAt + 18 });
  assert.equal(at.frame.ts, startedAt + 10);
  assert.equal(at.liquidations[0].id, recordedEvent.id);
  const missing = await fresh.get({ id: session.id, ts: startedAt + 20 });
  assert.equal(missing.frame.book, null);
  assert.match(missing.frame.gaps.join(' '), /没有可用的盘口/);
  await assert.rejects(fresh.get({ id: '../escape' }), /ID/);

  const exportText = await replay.exportNDJSON(session.id);
  const duplicate = await fresh.importNDJSON(exportText);
  assert.equal(duplicate.origin, 'imported');
  assert.equal(duplicate.frames, stopped.frames);
  assert.equal((await fresh.get({ id: duplicate.id, ts: recordedEvent.ts })).liquidations.length, 1);
  assert.equal(exportText.split('\n').map(row => row && JSON.parse(row)).filter(row => row.type === 'liquidation').length, 1);
});

test('tracks real stream acknowledgements and records events before the first book poll completes', async t => {
  class Socket extends EventTarget {
    sent = [];
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const socket = new Socket();
  let finishMarket;
  const { replay } = await fixture(t, {
    now: () => startedAt,
    marketLoader: () => new Promise(resolve => { finishMarket = resolve; }),
    connectWebSocket: url => {
      assert.equal(url, 'wss://stream.bybit.com/v5/public/linear');
      return socket;
    },
  });
  const session = await replay.start({ venue: 'bybit', symbol: 'BTC' });
  socket.dispatchEvent(new Event('open'));
  assert.deepEqual(socket.sent, [{ op: 'subscribe', args: ['allLiquidation.BTCUSDT'] }]);
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ success: true, op: 'subscribe' }) }));
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
    topic: 'allLiquidation.BTCUSDT', data: [{ T: startedAt + 1, s: 'BTCUSDT', S: 'Sell', p: '100', v: '5' }],
  }) }));
  const data = await replay.get({ id: session.id });
  assert.equal(data.timeline.length, 1);
  assert.equal(data.frame, null);
  assert.equal(data.liquidationSource.label, 'Bybit 公开强平推送');
  assert.equal(data.liquidations[0].side, 'short');

  finishMarket({ book: { ts: startedAt, bids: levels, asks: levels } });
  await waitUntil(async () => (await replay.list())[0].frames === 1);
  const ended = await replay.stop(session.id);
  assert.equal(ended.endedAt, startedAt + 1);
});

test('reports a failed stream while continuing to record REST order books', async t => {
  const { replay } = await fixture(t, {
    now: () => startedAt,
    marketLoader: async () => ({ book: { ts: startedAt, bids: levels, asks: levels } }),
    connectWebSocket: () => { throw new Error('offline'); },
  });
  const { id } = await replay.start({ venue: 'binance', symbol: 'BTC' });
  await waitUntil(async () => (await replay.get({ id })).frame !== null);
  const result = await replay.get({ id });
  assert.equal(result.session.state, 'recording');
  assert.equal(result.frame.streamStatus, 'disconnected');
  assert.match(result.frame.gaps.join(' '), /尚未连接/);
  assert.equal(result.frame.book.bids.length, 1);
  assert.deepEqual(result.liquidations, []);
});

test('keeps complete local observations if the process stopped mid-write', async t => {
  const { replay, directory } = await fixture(t);
  const header = { type: 'session', version: 1, venue: 'okx', symbol: 'BTC', startedAt };
  const frame = { type: 'frame', ts: startedAt + 20, book: null, liquidations: [], gaps: [] };
  const { id } = await replay.importNDJSON(JSON.stringify(header) + '\n' + JSON.stringify(frame));
  await appendFile(join(directory, 'replays', id + '.ndjson'), '{"type":"frame"');
  const result = await replay.get({ id });
  assert.equal(result.session.frames, 1);
  assert.equal(result.frame.ts, frame.ts);
});

test('rejects invalid imports and marks user-supplied files as imported', async t => {
  const { replay } = await fixture(t);
  const header = { type: 'session', version: 1, venue: 'okx', symbol: 'BTC', startedAt };
  const frame = {
    type: 'frame', ts: startedAt + 20, book: null, liquidations: [recordedEvent], gaps: [],
    sources: { liquidations: { url: 'https://www.okx.com.example.com/', quality: 'measured', label: '文件提供的来源' } },
  };
  const text = (...rows) => rows.map(row => JSON.stringify(row)).join('\n');
  await assert.rejects(replay.importNDJSON(text(header)), /没有盘口/);
  await assert.rejects(replay.importNDJSON(text(header, frame, { ...frame, ts: startedAt - 1 })), /逆序/);
  await assert.rejects(replay.importNDJSON(text(header, frame, { type: 'stop', ts: startedAt + 10 })), /结束时间/);
  await assert.rejects(replay.importNDJSON(text(header, frame, { type: 'liquidation', ...recordedEvent, size: 3 })), /不同观测/);
  assert.deepEqual(await replay.list(), []);
  const imported = await replay.importNDJSON(text(header, frame));
  assert.equal(imported.origin, 'imported');
  const selected = await replay.get({ id: imported.id });
  assert.equal(selected.liquidations[0].notional, 198);
  assert.equal(selected.liquidationSource.url, null);
});
