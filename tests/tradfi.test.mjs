import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTradfi } from '../tradfi.mjs';

const time = 1794675300000;
const context = { markPx: '100', oraclePx: '99', prevDayPx: '80', dayNtlVlm: '1010', openInterest: '15', funding: '0.0001' };
const visible = ['io:ANTH', 'xyz:OURA', 'xyz:SPCX', 'xyz:GOLD', 'xyz:EUR', 'xyz:XYZ100'];
const categories = [['io:ANTH', 'preipo'], ['xyz:OURA', 'preipo'], ['xyz:SPCX', 'stocks'], ['xyz:GOLD', 'commodities'], ['xyz:EUR', 'FX'], ['xyz:XYZ100', 'indices'], ['xyz:DELIST', 'preipo'], ['xyz:BTC', 'crypto']];
const market = (name) => ({ name, ...(name === 'xyz:DELIST' ? { isDelisted: true } : {}) });
const binanceMarket = (symbol, underlyingType, options = {}) => ({ symbol, baseAsset: symbol.slice(0, -4), contractType: 'TRADIFI_PERPETUAL', status: 'TRADING', quoteAsset: 'USDT', underlyingType, underlyingSubType: underlyingType === 'PREMARKET' ? ['Pre-IPO', 'TradFi'] : ['TradFi'], ...options });
const bnMarkets = [
  binanceMarket('ANTHROPICUSDT', 'PREMARKET'), binanceMarket('OPENAIUSDT', 'PREMARKET'), binanceMarket('SPCXUSDT', 'EQUITY'),
  binanceMarket('NONIPOUSDT', 'PREMARKET', { underlyingSubType: ['Pre-Market'] }), binanceMarket('CRYPTOUSDT', 'INDEX', { contractType: 'PERPETUAL' }),
  binanceMarket('STALEUSDT', 'EQUITY', { status: 'SETTLING' }),
];

function fixture({ failure, badDex = false, extraMarkets = [] } = {}) {
  const calls = [];
  const fetchImpl = async (input, request) => {
    const url = new URL(input);
    if (url.hostname === 'api.hyperliquid.xyz') {
      const body = JSON.parse(request.body);
      calls.push(`${body.type}:${body.dex ?? ''}`);
      if (failure === 'hyperliquid') return new Response('{}', { status: 503 });
      if (body.type === 'perpCategories') return Response.json(categories);
      if (body.type === 'allPerpMetas') return Response.json([{ universe: [market('BTC')] }, { universe: [...visible.slice(1), 'xyz:DELIST', 'xyz:BTC'].map(market) }, { universe: [market('io:ANTH')] }]);
      if (body.dex === 'xyz') {
        const universe = [...visible.slice(1), 'xyz:DELIST', 'xyz:BTC'].map(market);
        return Response.json([{ universe, collateralToken: 0 }, universe.slice(badDex ? 1 : 0).map(() => context)]);
      }
      if (body.dex === 'io') return Response.json([{ universe: [market('io:ANTH')], collateralToken: 0 }, [{ ...context, oraclePx: null }]]);
    }
    const symbol = url.searchParams.get('symbol');
    calls.push(`${url.pathname}:${symbol ?? ''}`);
    if (failure === 'binance') return new Response('{}', { status: 503 });
    const symbols = [...bnMarkets, ...extraMarkets];
    if (url.pathname.endsWith('/exchangeInfo')) return Response.json({ symbols });
    if (url.pathname.endsWith('/ticker/24hr')) return Response.json(symbols.map((m) => ({ symbol: m.symbol, closeTime: time, quoteVolume: m.symbol.startsWith('SPCX') ? '2500' : '1000', priceChangePercent: '-1' })));
    if (url.pathname.endsWith('/premiumIndex')) return Response.json(symbols.map((m) => ({ symbol: m.symbol, markPrice: '90', indexPrice: '91', lastFundingRate: '0.0005', time })));
    if (url.pathname.endsWith('/openInterest')) return Response.json({ symbol, openInterest: '20', time });
    if (url.pathname.endsWith('/globalLongShortAccountRatio')) return Response.json([{ symbol, longShortRatio: '2', longAccount: '0.667', shortAccount: '0.333', timestamp: time }]);
    throw new Error(`unexpected: ${url}`);
  };
  return { fetchImpl, calls };
}

test('projects live exchange classifications, feeds and audited pre-IPO quote bases', async () => {
  const { fetchImpl } = fixture();
  const result = await loadTradfi({ fetchImpl, binanceOiLimit: 2 });
  assert.equal(result.rows.length, 9);
  assert(!result.rows.some((row) => /DELIST|NONIPO|CRYPTO|STALE|:BTC/.test(row.id)));
  const byId = Object.fromEntries(result.rows.map((row) => [row.id, row]));
  const foreign = byId['hyperliquid:xyz:EUR'];
  assert.equal(foreign.category, 'fx');
  assert.equal(foreign.changePct24h, 25);
  assert.equal(foreign.openInterestUsd, 1500);
  assert.equal(foreign.fieldSources.openInterestUsd.quality, 'estimated');
  assert.equal(foreign.instrumentType, 'synthetic-perpetual');
  const entropy = byId['hyperliquid:io:ANTH'];
  assert.equal(entropy.quoteBasis, 'company-valuation');
  assert.equal(entropy.impliedValuationUsd, 100e9);
  assert.equal(entropy.fieldSources.impliedValuationUsd.raw.multiplier, 1e9);
  assert.equal(entropy.oraclePrice, null);
  const anthropic = byId['binance:ANTHROPICUSDT'];
  assert.equal(anthropic.impliedValuationUsd, 90e9);
  assert.equal(anthropic.oraclePrice, null);
  assert.equal(anthropic.fieldSources.oraclePrice.raw.indexPrice, '91');
  assert.equal(anthropic.fundingRatePct, 0.05);
  assert.equal(anthropic.openInterestUsd, 1800);
  assert.equal(anthropic.longRatio, 2);
  assert.equal(anthropic.fieldSources.longRatio.raw.longAccount, '0.667');
  assert.equal(anthropic.quoteCurrency, 'USDT');
  assert.match(anthropic.termsUrl, /support\/announcement/);
  assert.equal(byId['binance:OPENAIUSDT'].impliedValuationUsd, null);
  assert.equal(byId['binance:SPCXUSDT'].category, 'equity');
  assert.equal(byId['binance:SPCXUSDT'].openInterest, null);
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.venues[1].missingFields.openInterest, 1);
  assert.match(result.coverage.venues[1].link, /developers\.binance\.com/);
});

test('filters venues and limits endpoint fan-out with pre-IPO priority', async () => {
  const extras = ['ALPHAUSDT', 'BETATUSDT', 'GAMMAUSDT'].map((symbol) => binanceMarket(symbol, 'PREMARKET'));
  const { fetchImpl, calls } = fixture({ extraMarkets: extras });
  const result = await loadTradfi({ venue: 'binance', binanceOiLimit: 1, fetchImpl });
  assert.equal(result.rows.length, 6);
  assert.equal(result.venue, 'binance');
  assert(calls.every((call) => call.startsWith('/')));
  assert.deepEqual(calls.filter((call) => call.includes('openInterest')), ['/fapi/v1/openInterest:ALPHAUSDT']);
  assert.equal(calls.filter((call) => call.includes('globalLongShortAccountRatio')).length, 4);
  assert(await loadTradfi({ venue: 'hyperliquid', fetchImpl }).then((x) => x.rows.every((row) => row.venue === 'hyperliquid')));
  await assert.rejects(loadTradfi({ venue: 'other' }), /仅支持/);
});

test('preserves healthy markets when a venue or DEX returns malformed or unavailable data', async () => {
  const dexFailure = await loadTradfi({ venue: 'hyperliquid', fetchImpl: fixture({ badDex: true }).fetchImpl });
  assert.equal(dexFailure.rows.length, 1);
  assert.equal(dexFailure.coverage.status, 'partial');
  assert.match(dexFailure.coverage.reason, /xyz/);
  assert.equal(dexFailure.coverage.venues[0].totalMarkets, 6);
  const venueFailure = await loadTradfi({ binanceOiLimit: 0, fetchImpl: fixture({ failure: 'binance' }).fetchImpl });
  assert.equal(venueFailure.rows.length, 6);
  assert.equal(venueFailure.coverage.venues[1].status, 'missing');
  const singleFailure = await loadTradfi({ venue: 'binance', fetchImpl: fixture({ failure: 'binance' }).fetchImpl });
  assert.equal(singleFailure.coverage.status, 'missing');
  assert.equal(singleFailure.rows.length, 0);
});
