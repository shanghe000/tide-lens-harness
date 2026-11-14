import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDelistings } from '../delistings.mjs';

const asOf = Date.parse('2026-11-15T00:00:00Z');
const sevenDays = Date.parse('2026-11-08T00:00:00Z');
const binanceSpot = '12345678123456781234567812345678';
const temporarySuspension = 'ec32e6657ae341b3b57f1b154c330c6d';
const misleadingIndex = '22222222222222222222222222222222';
const bybitMain = 'https://announcements.bybit.com/en-US/article/';

function stub(routes) {
  return async (url, options) => {
    const query = new URL(url);
    const result = routes[query.pathname];
    assert.ok(result !== undefined, 'unexpected route: ' + query.pathname);
    assert.equal(options.headers['accept-language'], 'en-US');
    return typeof result === 'function' ? result(query) : Response.json(result);
  };
}

function articleBody(...lines) {
  return JSON.stringify({ node: 'root', child: lines.map(text => ({ node: 'element', tag: 'p', child: [{ node: 'text', text }] })) });
}

test('Binance keeps official USDT perpetual schedule and verified spot events, excluding temporary suspensions', async () => {
  const upcoming = Date.parse('2026-11-20T09:00:00Z');
  const title = 'Notice of Removal of Spot Trading Pairs - 2026-11-16';
  const suspensionTitle = 'Temporary Suspension of SNDKB Perpetual Contracts on 2026-11-20';
  let readTemporary = false;
  const fetchImpl = stub({
    '/fapi/v1/exchangeInfo': { symbols: [
      { symbol: 'ABCUSDT', baseAsset: 'ABC', quoteAsset: 'USDT', contractType: 'PERPETUAL', status: 'TRADING', deliveryDate: upcoming },
      { symbol: 'BTCUSDT', quoteAsset: 'USDT', contractType: 'PERPETUAL', deliveryDate: 4_133_404_800_000 },
      { symbol: 'ETHUSDT_261225', quoteAsset: 'USDT', contractType: 'CURRENT_QUARTER', deliveryDate: upcoming },
      { symbol: 'ABCUSDC', quoteAsset: 'USDC', contractType: 'PERPETUAL', deliveryDate: upcoming },
    ] },
    '/bapi/composite/v1/public/cms/article/catalog/list/query': { code: '000000', data: { total: 8, articles: [
      { code: binanceSpot, title },
      { code: temporarySuspension, title: suspensionTitle },
      { code: misleadingIndex, title: 'Binance Futures Will Delist SNDKBUSDT Perpetual Contract (2026-11-20)' },
    ] } },
    '/bapi/composite/v1/public/cms/article/detail/query': url => {
      const code = url.searchParams.get('articleCode');
      if (code === temporarySuspension) readTemporary = true;
      if (code === misleadingIndex || code === temporarySuspension) return Response.json({ code: '000000', data: {
        code, title: suspensionTitle, publishDate: asOf - 1,
        body: articleBody('Binance Futures will temporarily suspend SNDKBUSDT at 2026-11-20 00:30 (UTC) and resume at 2026-11-20 09:00 (UTC).'),
      } });
      return Response.json({ code: '000000', data: { code, title, publishDate: asOf - 2,
        body: articleBody('Binance will remove the following spot trading pairs:',
          'At 2026-11-16 03:00 (UTC): ABC/USDT and DEF/BTC',
          'Please Note:', 'Trading Bots for ABC/USDT and DEF/BTC cease at 2026-11-16 04:00 (UTC).'),
        footer: { createUser: 'do-not-return' },
      } });
    },
  });
  const result = await loadDelistings({ venue: 'binance', window: '7d', fetchImpl, now: asOf });
  assert.equal(result.recentSince, sevenDays);
  assert.equal(result.timezone, 'UTC');
  assert.equal(readTemporary, false);
  assert.equal(result.rows.length, 2);
  const [spot, perpetual] = result.rows;
  assert.equal(spot.marketType, 'spot');
  assert.equal(spot.kind, 'announcement');
  assert.equal(spot.stage, 'upcoming');
  assert.deepEqual(spot.symbols, ['ABC/USDT', 'DEF/BTC']);
  assert.equal(spot.effectiveAt, Date.parse('2026-11-16T03:00:00Z'));
  assert.equal(spot.raw.footer, undefined);
  assert.equal(spot.raw.utcText, '2026-11-16 03:00 (UTC)');
  assert.equal(perpetual.symbol, 'ABCUSDT');
  assert.equal(perpetual.marketType, 'perpetual');
  assert.equal(perpetual.raw.deliveryDate, upcoming);
  assert.equal(perpetual.publishedAt, null);
  assert.equal(result.sources.binance[1].limited, true);
});

test('Bybit keeps publish and effective times separate, including ambiguous recent notices', async () => {
  const earlier = Date.parse('2026-11-14T12:00:00Z');
  const entries = [
    { title: 'Delisting of A1USDT Perpetual Contract', description: 'Bybit will be delisting the A1USDT Perpetual Contract at Nov 20, 2026, 12:00AM UTC.' },
    { title: 'Delisting of A2USDT Perpetual Contract', description: 'Bybit will be delisting the A2USDT Perpetual Contract at Nov 13, 2026, 9:00AM UTC.' },
    { title: 'Bybit to Delist 12 Trading Pair(s) on Nov 16, 2026', description: 'Bybit conducts regular reviews of all listed Spot trading pairs.' },
    { title: 'Delisting of A3USDT Perpetual Contract Postponed', description: 'Bybit will delist the A3USDT Perpetual Contract at Nov 16, 2026, 9:00AM UTC instead of the originally scheduled Nov 15, 2026, 9:00AM UTC.' },
    { title: 'Delisting of A4USDT Perpetual Contract', description: 'Bybit will delist the A4USDT Perpetual Contract at Feb 31, 2026, 9:00AM UTC.' },
    { title: 'Delisting of A5USDT Perpetual Contract', description: 'Bybit will delist the A5USDT Perpetual Contract at Nov 20, 2026, 9:00AM UTC.', url: 'https://announcements.bybit.com.attacker.example/' },
  ].map((item, index) => ({ url: bybitMain + index + '/', publishTime: earlier, dateTimestamp: earlier - 8,
    startDateTimestamp: asOf + 1000, type: { key: 'delistings' }, ...item }));
  const fetchImpl = stub({
    '/v5/market/instruments-info': { retCode: 0, result: { list: [], nextPageCursor: '' } },
    '/v5/announcements/index': { retCode: 0, result: { total: 32, list: entries } },
  });
  const result = await loadDelistings({ venue: 'bybit', fetchImpl, now: () => asOf });
  assert.equal(result.rows.length, 5);
  assert.equal(result.rows[0].stage, 'upcoming');
  assert.equal(result.rows[0].effectiveAt, Date.parse('2026-11-20T00:00:00Z'));
  assert.equal(result.rows[0].publishedAt, earlier);
  assert.equal(result.rows[1].stage, 'recent');
  assert.equal(result.rows[1].effectiveAt, Date.parse('2026-11-13T09:00:00Z'));
  const spot = result.rows.find(row => row.marketType === 'spot');
  assert.equal(spot.effectiveAt, null);
  assert.equal(spot.stage, 'notice');
  assert.ok(result.rows.slice(2).every(row => row.effectiveAt === null));
  assert.equal(result.sources.bybit[0].status, 'empty');
  assert.equal(result.sources.bybit[1].limited, true);
});

test('OKX differentiates a successful empty region-scoped feed from an unavailable source', async () => {
  const fetchImpl = stub({
    '/api/v5/support/announcements': { code: '0', data: [{ details: [], totalPage: '1' }] },
    '/api/v5/public/instruments': url => url.searchParams.get('instType') === 'SPOT'
      ? Response.json({ code: '0', data: [{ instType: 'SPOT', instId: 'ABC-USDT', expTime: '0' }] })
      : new Response('{}', { status: 503 }),
  });
  const result = await loadDelistings({ venue: 'okx', fetchImpl, now: asOf });
  assert.deepEqual(result.rows, []);
  assert.equal(result.sources.okx[0].status, 'unavailable');
  assert.equal(result.sources.okx[0].count, null);
  assert.equal(result.sources.okx[1].status, 'empty');
  assert.equal(result.sources.okx[1].count, 0);
  assert.equal(result.sources.okx[2].kind, 'spot-schedule');
  assert.equal(result.sources.okx[2].status, 'empty');
  assert.match(result.errors['okx:schedule'], /503/u);
  await assert.rejects(loadDelistings({ venue: 'okx', fetchImpl, window: 'constructor' }), /最近/);
});

test('Bybit keeps first-page schedules and discloses a pagination failure', async () => {
  const effectiveAt = Date.parse('2026-11-21T01:00:00Z');
  const fetchImpl = stub({
    '/v5/market/instruments-info': url => {
      if (url.searchParams.has('cursor')) return new Response('{}', { status: 429 });
      return Response.json({ retCode: 0, result: { nextPageCursor: 'next', list: [
        { symbol: 'ABCUSDT', contractType: 'LinearPerpetual', quoteCoin: 'USDT', status: 'Trading', deliveryTime: String(effectiveAt) },
        { symbol: 'DEFUSDT-12DEC', contractType: 'LinearFutures', quoteCoin: 'USDT', status: 'Delivering', deliveryTime: String(effectiveAt) },
      ] } });
    },
    '/v5/announcements/index': { retCode: 0, result: { total: 0, list: [] } },
  });
  const result = await loadDelistings({ venue: 'bybit', fetchImpl, now: asOf });
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].effectiveAt, effectiveAt);
  assert.equal(result.sources.bybit[0].status, 'partial');
  assert.equal(result.sources.bybit[0].limited, true);
  assert.equal(result.sources.bybit[1].status, 'empty');
});
