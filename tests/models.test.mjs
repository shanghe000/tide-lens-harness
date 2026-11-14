import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectLiquidations } from '../models.mjs';
import { createReviews, factForMarket } from '../reviews.mjs';

const origin = 1_794_000_000_000;
const minute = 60_000;

function candles(closes) {
  return closes.map((close, index) => ({
    ts: origin + index * minute, close, low: close - 0.1, high: close + 0.1,
  }));
}

function interest(values) {
  return values.map((value, index) => ({ ts: origin + (index + 1) * minute, value }));
}

test('projects equal long/short positions, scales reductions, and retires crossed bands', () => {
  const model = projectLiquidations({
    candles: candles([100, 100, 99, 99, 90]),
    series: { oi: interest([100, 110, 110, 105, 105]) },
    leverage: [10, 25],
    marginRate: 0.005,
  });

  assert.equal(model.quality, 'estimated');
  assert.equal(model.coverage.matchedChanges, 4);
  assert.equal(model.coverage.positiveChanges, 1);
  assert.deepEqual(model.cells.filter(cell => cell.ts === origin + 2 * minute)
    .map(({ side, rawScore }) => [side, rawScore]), [
    ['long', 5], ['short', 5], ['long', 5], ['short', 5],
  ]);
  assert.ok(model.cells.every(cell => cell.intensity > 0 && cell.intensity <= 1));
  assert.deepEqual(model.levels.map(level => level.side), ['short', 'short']);
  assert.ok(model.levels.every(level => level.rawScore === 5 * (105 / 110)));
});

test('excludes incomplete candles and avoids inferring a model from price alone', () => {
  const prices = candles([100, 101, 90]);
  const options = { candles: prices, asOf: origin + 2.5 * minute };
  const model = projectLiquidations({ ...options, series: { oi: interest([100, 102, 107]) } });

  assert.equal(model.coverage.candles, 2);
  assert.equal(model.coverage.endsAt, origin + 2 * minute);
  assert.ok(model.levels.some(level => level.side === 'long'));
  const missing = projectLiquidations({ ...options, series: { oiUsd: interest([100, 102, 107]) } });
  assert.equal(missing.quality, 'missing');
  assert.deepEqual(missing.cells, []);
  assert.throws(() => projectLiquidations({ ...options, marginRate: 0.015 }), RangeError);
});

test('seals observations with their source and timestamp and returns only approved snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tide-lens-model-review-test-'));
  try {
    const market = {
      venue: 'okx', symbol: 'BTC', asOf: origin + minute,
      metrics: { price: 100 },
      metricsTimes: { price: origin },
      sources: { price: { label: 'OKX', quality: 'measured', url: 'https://www.okx.com/' } },
    };
    const observed = factForMarket(market, 'price');
    const revised = factForMarket({ ...market, metrics: { price: 101 } }, 'price');
    const sourceChanged = factForMarket({
      ...market, sources: { price: { ...market.sources.price, method: 'Changed source details' } },
    }, 'price');
    assert.equal(observed.asOf, origin);
    assert.notEqual(observed.id, revised.id);
    assert.notEqual(observed.id, sourceChanged.id);
    assert.equal(factForMarket(market, 'oi'), null);

    const store = createReviews(directory);
    await assert.rejects(store.set({ ...observed, value: 200 }, true), /重新核对/);
    await Promise.all([
      store.set(observed, 'approve'),
      store.set(revised, 'reject'),
    ]);
    const reloaded = createReviews(directory);
    assert.deepEqual(await reloaded.approved(), [observed]);
    assert.deepEqual(await reloaded.approved({ ids: [revised.id] }), []);
    await reloaded.set(observed, 'revoke');
    assert.deepEqual(await store.approved(), []);
    assert.equal((await store.list()).find(record => record.fact.id === observed.id).decision, 'revoked');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
