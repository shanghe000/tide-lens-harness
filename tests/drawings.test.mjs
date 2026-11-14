import assert from 'node:assert/strict';
import test from 'node:test';
import { createDrawingController, drawingKey, measureDrawing, normalizeDrawings } from '../ui/drawings.js';

const start = 1_790_000_000_000;
const hour = 3_600_000;

function anchor(ts = start, price = 100) {
  return { ts, price };
}

function chart({ min = start, max = start + hour, low = 90, high = 110, width = 100 } = {}) {
  const steps = [];
  const g = Object.fromEntries(
    ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'rect', 'clip', 'fillRect', 'setLineDash', 'arc', 'fill']
      .map(method => [method, (...args) => steps.push([method, ...args])]),
  );
  return {
    g, steps, min, max, low, high, left: 10, right: 10 + width, top: 10, bottom: 110,
    x: ts => 10 + width * (ts - min) / Math.max(max - min, 1),
    y: price => 110 - 100 * (price - low) / (high - low),
  };
}

function cursor(x, y, extra = {}) {
  let focused = false;
  return {
    clientX: x + 5, clientY: y + 7, button: 0,
    currentTarget: {
      getBoundingClientRect: () => ({ left: 5, top: 7 }),
      focus: options => { focused = options.preventScroll; },
    },
    wasFocused: () => focused,
    ...extra,
  };
}

function keys(controller, key, options = {}) {
  let prevented = false;
  const handled = controller.key({ key, ...options, preventDefault: () => { prevented = true; } });
  assert.equal(handled, prevented);
  return handled;
}

test('validates saved shapes, clones anchors, and caps retained drawings', () => {
  assert.equal(drawingKey(' OKX ', ' btc '), 'okx:BTC');
  assert.equal(drawingKey('okx', '../BTC'), null);
  assert.equal(drawingKey(null, 'BTC'), null);

  const horizontal = { type: 'horizontal', from: anchor(), payload: '<script>' };
  const trend = { type: 'trend', from: anchor(), to: anchor(start + hour, 110) };
  const normalized = normalizeDrawings([
    horizontal, trend, { ...trend, type: 'unknown' }, { ...trend, from: null },
    { ...trend, to: anchor(start, -100) }, { ...trend, to: anchor(start, Infinity) },
    { ...trend, to: anchor(1.1) }, { ...trend, to: anchor(8.65e15) }, { ...trend, to: trend.from },
  ]);
  assert.deepEqual(normalized, [{ type: 'horizontal', from: horizontal.from }, trend]);
  normalized[0].from.price = 777;
  assert.equal(horizontal.from.price, 100);
  assert.equal(normalizeDrawings(Array(120).fill(horizontal)).length, 100);
  assert.deepEqual(normalizeDrawings({}), []);
});

test('measures signed price change and elapsed duration in either anchor order', () => {
  const from = anchor(start + hour, 100);
  const to = anchor(start, 90);
  const result = measureDrawing({ type: 'measure', from, to });
  assert.deepEqual(result, { priceChange: -10, percentChange: -10, elapsedMs: hour });
  assert.equal(measureDrawing({ type: 'trend', from, to }), null);
  assert.equal(measureDrawing({ type: 'measure', from: null, to }), null);
});

test('pointer stages, commits, and projects a trend across chart sizes and windows', () => {
  const stored = new Map();
  const controller = createDrawingController({
    load: key => stored.get(key), save: (key, items) => stored.set(key, items),
  });
  controller.setMarket('okx', 'BTC');
  const base = chart();
  controller.setBase(base);
  assert.equal(controller.pointer(cursor(40, 40)), false);
  assert.equal(controller.setTool('trend'), true);
  assert.equal(controller.click(cursor(150, 35)), true);
  assert.equal(controller.snapshot().anchor, null);
  const first = cursor(10, 85);
  assert.equal(controller.click(first), true);
  assert.equal(first.wasFocused(), true);
  assert.deepEqual(controller.snapshot().anchor, anchor(start, 95));
  assert.equal(controller.click(cursor(10, 85)), true);
  assert.equal(stored.size, 0);
  assert.equal(controller.pointer(cursor(110, 35)), true);
  assert.deepEqual(controller.snapshot().position, anchor(start + hour, 105));
  assert.equal(controller.leave(), true);
  assert.deepEqual(controller.snapshot().anchor, anchor(start, 95));
  assert.equal(controller.snapshot().position, null);
  assert.equal(controller.click(cursor(110, 35)), true);
  const expected = [{ type: 'trend', from: anchor(start, 95), to: anchor(start + hour, 105) }];
  assert.deepEqual(stored.get('okx:BTC'), expected);
  controller.render();
  assert.ok(base.steps.some(step => step.join(',') === 'moveTo,10,85'));
  assert.ok(base.steps.some(step => step.join(',') === 'lineTo,110,35'));

  const zoom = chart({ min: start - hour, max: start + 2 * hour, low: 50, high: 150, width: 300 });
  controller.setBase(zoom);
  controller.render();
  assert.deepEqual(zoom.steps.slice(0, 4), [['save'], ['beginPath'], ['rect', 10, 10, 300, 100], ['clip']]);
  assert.ok(zoom.steps.some(([method, x, y]) => method === 'moveTo' && x === 110 && Math.abs(y - 65) < 1e-8));
  assert.ok(zoom.steps.some(([method, x, y]) => method === 'lineTo' && x === 210 && Math.abs(y - 55) < 1e-8));
  assert.deepEqual(controller.snapshot().items, expected);
});

test('supports drawing, measurement preview and cancellation through standard keys', () => {
  const controller = createDrawingController();
  controller.setMarket('okx', 'BTC');
  controller.setBase(chart());
  assert.equal(controller.setTool('measure'), true);
  assert.equal(keys(controller, 'Tab'), false);
  assert.equal(keys(controller, 'ArrowLeft', { metaKey: true }), false);
  assert.equal(keys(controller, 'Enter'), true);
  assert.deepEqual(controller.snapshot().anchor, anchor(start + hour / 2, 100));
  assert.equal(keys(controller, 'ArrowRight', { shiftKey: true }), true);
  assert.equal(keys(controller, 'ArrowUp', { shiftKey: true }), true);
  assert.deepEqual(controller.snapshot().measurement, { priceChange: 2, percentChange: 2, elapsedMs: hour / 10 });
  assert.equal(keys(controller, ' ', { repeat: true }), true);
  assert.equal(controller.snapshot().items.length, 0);
  assert.equal(keys(controller, ' '), true);
  assert.equal(controller.snapshot().items.length, 1);
  assert.equal(keys(controller, 'Enter'), true);
  assert.equal(keys(controller, 'Escape'), true);
  assert.equal(controller.snapshot().anchor, null);
  assert.equal(controller.snapshot().tool, 'measure');
  assert.equal(keys(controller, 'Escape'), true);
  assert.equal(controller.snapshot().tool, 'cursor');
  assert.equal(keys(controller, 'ArrowLeft'), false);
});

test('persists per venue and symbol across mounts and limits mutations to active market', () => {
  const stored = new Map();
  const options = { load: key => stored.get(key), save: (key, items) => stored.set(key, items) };
  const first = createDrawingController(options);
  assert.equal(first.setMarket(' OKX ', 'BTC'), true);
  assert.equal(first.setTool('horizontal'), true);
  assert.equal(first.setTool('unexpected'), false);
  first.setBase(chart());
  assert.equal(first.click(cursor(60, 60, { button: 2 })), false);
  assert.equal(first.click(cursor(60, 60)), true);
  assert.equal(first.click(cursor(60, 85)), true);
  assert.deepEqual(stored.get('okx:BTC'), [{ type: 'horizontal', from: anchor(start + hour / 2, 100) },
    { type: 'horizontal', from: anchor(start + hour / 2, 95) }]);

  const second = createDrawingController(options);
  second.setMarket('binance', 'BTC');
  assert.equal(second.undo(), false);
  second.setMarket('okx', 'ETH');
  assert.equal(second.clear(), false);
  second.setMarket('okx', 'BTC');
  assert.equal(second.snapshot().items.length, 2);
  const copy = second.snapshot();
  copy.items[0].from.price = 500;
  assert.equal(second.snapshot().items[0].from.price, 100);
  assert.equal(second.undo(), true);
  assert.equal(stored.get('okx:BTC').length, 1);
  assert.equal(second.clear(), true);
  assert.deepEqual(stored.get('okx:BTC'), []);
  assert.equal(stored.size, 1);
});

test('rejects empty chart interactions and keeps session drawings after storage errors', () => {
  const observed = [];
  const controller = createDrawingController({
    load: () => { throw new Error('unreadable'); },
    save: () => { throw new Error('unwritable'); },
    change: snapshot => observed.push(snapshot),
  });
  controller.setMarket('okx', 'BTC');
  controller.setTool('horizontal');
  controller.setBase(null);
  assert.equal(controller.click(cursor(60, 60)), true);
  assert.equal(controller.snapshot().items.length, 0);
  assert.equal(controller.snapshot().storageError, '本机未能读取已保存的绘图。');
  controller.setBase(chart({ max: start }));
  assert.equal(keys(controller, 'Enter'), true);
  assert.equal(observed.at(-1).storageError, '本机未能保存绘图。');
  controller.setMarket('binance', 'BTC');
  controller.setMarket('okx', 'BTC');
  assert.deepEqual(controller.snapshot().items, [{ type: 'horizontal', from: anchor() }]);
  assert.equal(controller.snapshot().storageError, '本机未能保存绘图。');
});

test('reports asynchronous storage failure only for the affected latest market edit', async () => {
  const writes = [];
  const controller = createDrawingController({ save: (key, items) => new Promise((resolve, reject) => {
    writes.push({ key, items, resolve, reject });
  }) });
  const settled = () => new Promise(resolve => setImmediate(resolve));
  controller.setMarket('okx', 'BTC');
  controller.setTool('horizontal');
  controller.setBase(chart());
  controller.click(cursor(60, 60));
  controller.click(cursor(60, 85));
  assert.equal(writes.length, 1);
  writes[0].reject(new Error('earlier edit'));
  await settled();
  assert.equal(writes[1].items.length, 2);
  assert.equal(controller.snapshot().storageError, null);

  controller.setMarket('bybit', 'ETH');
  writes[1].reject(new Error('latest edit'));
  await settled();
  assert.equal(controller.snapshot().storageError, null);
  controller.setMarket('okx', 'BTC');
  assert.equal(controller.snapshot().storageError, '本机未能保存绘图。');
  assert.equal(controller.snapshot().items.length, 2);
  assert.equal(controller.undo(), true);
  writes[2].resolve();
  assert.equal(controller.snapshot().storageError, null);
});
