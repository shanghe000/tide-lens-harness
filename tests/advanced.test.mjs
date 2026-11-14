import assert from 'node:assert/strict';
import { test } from 'node:test';
import { calculate, evaluateAlerts, loadWhale } from '../advanced.mjs';

function near(value, expected) {
  assert.ok(Math.abs(value - expected) < 1e-8, `${value} differs from ${expected}`);
}

test('calculates isolated long PnL, fees, funding, risk and initial liquidation', () => {
  const result = calculate({
    side: 'long', entryPrice: 100, exitPrice: 120, leverage: '10', margin: 50, maintenanceRatePct: 0.5,
    feeRatePct: 0.05, fundingRatePct: 0.01, fundingPeriods: 3, accountBalance: 1000, riskPct: 1, stopPrice: 95, targetPrice: 110,
  });
  near(result.quantity, 5);
  near(result.initialMargin, 50);
  near(result.pnl, 100);
  near(result.fees, 0.55);
  near(result.fundingPayment, -0.15);
  near(result.netPnl, 99.30);
  near(result.liquidationPrice, 450 / 4.975);
  near(result.riskQuantity, 10 / 5.0975);
  assert.equal(result.quality, 'estimated');
});

test('short funding flows in, requires a valid stop, and retains missing margin data', () => {
  const result = calculate({
    side: 'short', entryPrice: 100, exitPrice: 90, leverage: 10, quantity: 5,
    maintenanceRatePct: 0.5, fundingRatePct: 0.01, stopPrice: 105, targetPrice: 95,
  });
  near(result.netPnl, 50.05);
  near(result.liquidationPrice, 550 / 5.025);
  near(result.rewardRisk, 1);
  assert.equal(calculate({ side: 'long', entryPrice: 100, leverage: 1, margin: 100 }).liquidationPrice, null);
  assert.throws(() => calculate({ side: 'long', entryPrice: 100, leverage: 1, margin: 100, stopPrice: 110 }), /止损价/);
});

test('normalizes real-shaped Hyperliquid public responses and preserves missing values', async () => {
  const address = `0x${'01'.repeat(20)}`;
  const fetchImpl = async (url, request) => {
    assert.equal(url, 'https://api.hyperliquid.xyz/info');
    assert.equal(request.method, 'POST');
    assert.deepEqual(JSON.parse(request.body), { type: 'clearinghouseState', user: address });
    return new Response(JSON.stringify({
      marginSummary: { accountValue: '200', totalMarginUsed: '50', totalNtlPos: '500' },
      withdrawable: '150', time: 1794672351250,
      assetPositions: [{ position: { coin: 'ETH', szi: '-2', positionValue: '500', entryPx: '260', liquidationPx: null, leverage: { value: 10, type: 'cross' }, unrealizedPnl: '20', returnOnEquity: '0.4' } }],
    }));
  };
  const result = await loadWhale(address, { fetchImpl });
  assert.equal(result.timestamp, '2026-11-14T16:05:51.250Z');
  assert.equal(result.positions[0].side, 'short');
  assert.equal(result.positions[0].markPrice, 250);
  assert.equal(result.positions[0].liquidationPrice, null);
  assert.equal(result.positions[0].returnOnEquityPct, 40);
  assert.equal(result.summary.accountValue, 200);
  await assert.rejects(loadWhale('invalid', { fetchImpl }), /公开钱包地址/);
  await assert.rejects(loadWhale(address, { fetchImpl: async () => new Response('{}', { status: 429 }) }), /过于频繁/);
});

test('evaluates threshold boundaries, no-data inputs, and disabled rules', () => {
  const result = evaluateAlerts([
    { id: 'drawdown', symbol: 'btc', metric: 'changePct', operator: 'lte', threshold: -2 },
    { id: 'expensive', metric: 'fundingRatePct', operator: 'gt', threshold: 0.01 },
    { id: 'volume', enabled: false, symbol: 'btc', metric: 'volumeUsd', operator: 'gt', threshold: 1 },
  ], [
    { symbol: 'BTC', changePct: -2, fundingRatePct: null, volumeUsd: 10 },
    { symbol: 'ETH', fundingRatePct: 0.01 },
  ]);
  assert.deepEqual(result.matches.map(({ ruleId, symbol }) => [ruleId, symbol]), [['drawdown', 'BTC']]);
  assert.deepEqual(result.unavailable, [{ ruleId: 'expensive', symbol: 'BTC', metric: 'fundingRatePct' }]);
  assert.equal(result.evaluated, 2);
  assert.throws(() => evaluateAlerts([], [{ symbol: 'BTC' }, { symbol: 'btc' }]), /重复交易对/);
});
