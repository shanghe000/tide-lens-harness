import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWhaleHistory } from '../whale-history.mjs';

const address = `0x${'a1'.repeat(20)}`;
const now = Date.parse('2026-11-14T16:25:00.000Z');
const endpoint = 'https://api.hyperliquid.xyz/info';
const iso = (time) => new Date(time).toISOString();

function fill({ time = now - 1000, startPosition = '0', sz = '1', side = 'B', coin = 'BTC', tid = 1 } = {}) {
  return { time, startPosition, sz, side, coin, tid, oid: 123, px: '66600.25', fee: '-0.50', feeToken: ' USDC ', closedPnl: '0', crossed: true, hash: 'omit-me' };
}

function fixture({ fills = [], fundings = [], current = [], checkpoint = now, fail } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const payload = JSON.parse(init.body);
    assert.equal(url, endpoint);
    assert.equal(init.method, 'POST');
    assert.equal(payload.user, address);
    requests.push(payload);
    if (payload.type === fail) return new Response('{}', { status: 503 });
    if (payload.type === 'clearinghouseState') return Response.json({ time: checkpoint, assetPositions: current.map(([coin, szi]) => ({ position: { coin, szi } })) });
    const rows = payload.type === 'userFillsByTime' ? fills : fundings;
    const result = rows.filter((row) => row.time >= payload.startTime && row.time <= payload.endTime);
    return Response.json(result.slice(0, 500));
  };
  return { fetchImpl, requests };
}

test('aligns with current checkpoint and orders equal-millisecond fills by exact position continuity', async () => {
  const time = now - 1000;
  const fills = [
    fill({ time, startPosition: '0.2', sz: '0.3', side: 'A', tid: 8 }),
    fill({ time, startPosition: '0.1', sz: '0.1', tid: 9 }),
    fill({ time, coin: 'PURR/USDC', tid: 10 }),
    fill({ time, coin: 'xyz:XYZ100', tid: 11 }),
  ];
  const fundings = [{ time: time - 5, hash: 'omit-me', delta: { coin: 'BTC', type: 'funding', szi: '0.1', usdc: ' -2.5', fundingRate: '0.0001' } }];
  const { fetchImpl, requests } = fixture({ fills, fundings, current: [['BTC', '-0.1'], ['ETH', '0.05']], checkpoint: now - 500 });
  const result = await loadWhaleHistory(address.toUpperCase().replace('0X', '0x'), { hours: 1, fetchImpl, now });
  assert.equal(result.end, iso(now - 500));
  assert(result.coverage.status === 'available');
  assert.equal(result.coverage.included, 2);
  assert.deepEqual(result.events.map((row) => [row.action, row.signedBefore, row.signedAfter]), [['add', 0.1, 0.2], ['flip', 0.2, -0.1]]);
  assert.equal(result.events[0].feeToken, 'USDC');
  assert.equal(result.events[0].fee, -0.5);
  assert.equal(result.events[0].raw.startPosition, '0.1');
  assert(!JSON.stringify(result).includes('omit-me'));
  assert.deepEqual(result.positions.map((item) => [item.symbol, item.initialQuantity, item.finalQuantity]), [['BTC', 0.1, -0.1], ['ETH', 0.05, 0.05]]);
  assert.deepEqual(result.positions[0].points.map((row) => row.quality), ['reconstructed', 'measured', 'reconstructed', 'measured', 'reconstructed', 'measured']);
  assert.equal(result.funding.events[0].amount, -2.5);
  assert.equal(result.funding.events[0].ratePct, 0.01);
  assert.equal(requests.find((p) => p.type === 'userFillsByTime').aggregateByTime, false);
  assert.equal(requests.find((p) => p.type === 'userFillsByTime').endTime, now - 500);
});

test('marks mismatched checkpoints and ambiguous same-block ordering as gaps', async () => {
  const time = now - 1000;
  const { fetchImpl } = fixture({
    current: [['BTC', '2'], ['ETH', '2']],
    fills: [fill({ time, coin: 'ETH', tid: 1 }), fill({ time, coin: 'ETH', tid: 2, sz: '2' }), fill({ time, tid: 3 })],
  });
  const result = await loadWhaleHistory(address, { fetchImpl, now });
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.events.length, 3);
  assert.deepEqual(result.coverage.gaps.map((row) => row.symbol), ['BTC', 'ETH']);
  assert.equal(result.positions[0].points.at(-2).signedQuantity, null);
  assert.equal(result.positions[1].initialQuantity, null);
  assert.equal(result.positions[1].points.at(-1).quality, 'measured');
});

test('preserves an exact closed position, zero current reading, and unknown when point source is stale', async () => {
  const active = [fill({ startPosition: '-0.2', sz: '0.2', side: 'B' })];
  const withCheckpoint = await loadWhaleHistory(address, { fetchImpl: fixture({ fills: active }).fetchImpl, now });
  assert.equal(withCheckpoint.events[0].action, 'close');
  assert.equal(withCheckpoint.positions[0].finalQuantity, 0);
  assert.equal(withCheckpoint.positions[0].points.at(-1).raw.absent, true);
  const stale = await loadWhaleHistory(address, { fetchImpl: fixture({ fills: active, checkpoint: now - 100_000 }).fetchImpl, now });
  assert.equal(stale.events[0].signedAfter, 0);
  assert.equal(stale.coverage.snapshot.status, 'missing');
  assert.equal(stale.positions[0].finalQuantity, null);
  const empty = await loadWhaleHistory(address, { fetchImpl: fixture().fetchImpl, now });
  assert.equal(empty.coverage.status, 'available');
  assert.deepEqual(empty.positions, []);
});

test('fills and funding coverage can fail independently and data gaps stay unknown', async () => {
  const { fetchImpl } = fixture({ current: [['BTC', '3']], fail: 'userFillsByTime' });
  const result = await loadWhaleHistory(address, { fetchImpl, now });
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.missingRanges.length, 1);
  assert.equal(result.positions[0].initialQuantity, null);
  assert.equal(result.positions[0].finalQuantity, 3);
  assert.equal(result.funding.coverage.status, 'available');
  const failedFunding = await loadWhaleHistory(address, { fetchImpl: fixture({ fail: 'userFunding' }).fetchImpl, now });
  assert.equal(failedFunding.coverage.status, 'available');
  assert.equal(failedFunding.funding.coverage.status, 'missing');
});

test('paginates inclusive times without losing the shared timestamp of a full exchange response', async () => {
  const start = now - 1000;
  const fills = Array.from({ length: 503 }, (_, id) => fill({ time: start + id, startPosition: String(id), tid: id }));
  const { fetchImpl, requests } = fixture({ fills, current: [['BTC', '503']] });
  const result = await loadWhaleHistory(address, { hours: 1, fetchImpl, now });
  assert.equal(result.coverage.included, 503);
  assert(!result.coverage.capped);
  assert.deepEqual(result.events.map((row) => row.signedBefore), Array.from({ length: 503 }, (_, index) => index));
  assert.ok(requests.filter((row) => row.type === 'userFillsByTime').length > 1);
});

test('leaves a capped same-millisecond block as missing coverage without inventing an opening quantity', async () => {
  const fills = Array.from({ length: 503 }, (_, id) => fill({ time: now, startPosition: String(id), tid: id }));
  const { fetchImpl } = fixture({ fills, current: [['BTC', '503']] });
  const result = await loadWhaleHistory(address, { hours: 1, fetchImpl, now });
  assert.equal(result.coverage.included, 500);
  assert.equal(result.coverage.capped, true);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.positions[0].initialQuantity, null);
  assert.equal(result.positions[0].finalQuantity, 503);
  assert.match(result.coverage.reason, /分页/);
});

test('validates address and observation window before any network request', async () => {
  const fetchImpl = () => assert.fail('invalid input cannot perform network request');
  await assert.rejects(loadWhaleHistory('private-key-string', { fetchImpl, now }), /公开钱包地址/);
  await assert.rejects(loadWhaleHistory(address, { hours: 169, fetchImpl, now }), /历史窗口/);
});
