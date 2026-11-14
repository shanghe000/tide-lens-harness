const formulaSource = 'https://www.okx.com/en-sg/help/forced-liquidation-faq';
const modelMethod = '以已收盘K线和基础币计量的未平仓量为输入。持仓净增加时，以最近一根已收盘K线的收盘价作为入场价，分别为多空双方构造等权杠杆仓位。持仓净减少时，按比例缩减仍在模型中的仓位。用线性逐仓公式和固定维持保证金率估算清算价，随后用K线高低价判断是否穿越。颜色以当前窗口最大格的估算规模归一化。';
const assumptions = [
  '杠杆档位及其权重为模型假设。可见持仓量无法给出实际杠杆、入场价、全仓抵押品、费率或追加保证金。',
  '用成交价K线近似标记价，以模型触及清算价代替逐账户清算判断。样本起点以前的仓位未参与投影。',
  '热度为窗口内的相对强度。格子的原始权重以基础币计算，来自持仓增减分配模型。',
];

function sortedRows(rows, valid) {
  const distinct = new Map();
  for (const row of rows ?? []) {
    if (Number.isFinite(row?.ts) && valid(row)) distinct.set(row.ts, row);
  }
  return [...distinct.values()].sort((a, b) => a.ts - b.ts);
}

function usualSpacing(rows) {
  const distances = rows.slice(1).map((row, index) => row.ts - rows[index].ts).sort((a, b) => a - b);
  return distances[Math.floor((distances.length - 1) / 2)];
}

function priceIncrement(price) {
  const target = price / 1_000;
  const unit = 10 ** Math.floor(Math.log10(target));
  return [1, 2, 5, 10].find(value => value * unit >= target) * unit;
}

function projectedPrice(entry, leverage, marginRate, side) {
  const direction = side === 'long' ? -1 : 1;
  return entry * (1 + direction / leverage) / (1 + direction * marginRate);
}

export function projectLiquidations({
  candles,
  series,
  sources,
  asOf,
  leverage = [10, 25, 50, 100],
  marginRate = 0.005,
} = {}) {
  const tiers = Array.isArray(leverage) ? [...new Set(leverage)].sort((a, b) => a - b) : [];
  if (!tiers.length || tiers.length > 12 ||
      !tiers.every(tier => Number.isFinite(tier) && tier > 1 && tier <= 1_000) ||
      !Number.isFinite(marginRate) || marginRate < 0 || tiers.some(tier => marginRate >= 1 / tier)) {
    throw new RangeError('杠杆与维持保证金率必须对应可建立的线性逐仓假设。');
  }

  const allPrices = sortedRows(candles, candle =>
    [candle.close, candle.low, candle.high].every(value => Number.isFinite(value) && value > 0) &&
    candle.low <= candle.close && candle.close <= candle.high);
  const step = usualSpacing(allPrices);
  const prices = allPrices.filter(candle => candle.confirmed !== false &&
    (!Number.isFinite(asOf) || candle.ts + step <= asOf));
  const oi = sortedRows(series?.oi, point => Number.isFinite(point.value) && point.value >= 0);
  const coverage = {
    candles: prices.length,
    oiObservations: oi.length,
    matchedChanges: 0,
    positiveChanges: 0,
    gapsSkipped: 0,
    candleGaps: 0,
    startsAt: null,
    endsAt: null,
  };
  const common = {
    method: modelMethod,
    assumptions,
    source: { label: '线性逐仓公式参考', url: formulaSource },
    inputs: {
      candles: sources?.candles ?? null,
      openInterest: sources?.oiHistory ?? sources?.oi ?? null,
    },
    leverage: tiers,
    marginRate,
  };
  const missing = reason => ({
    ...common, quality: 'missing', reason, coverage,
    cells: [], levels: [], priceStep: null, priceRange: null, maxRawScore: null,
  });
  if (prices.length < 2 || oi.length < 2) return missing('需要至少两根已收盘K线和两个基础币持仓量观察值。');

  const oiStep = usualSpacing(oi);
  const firstClose = prices[0].ts + step;
  const lastClose = prices.at(-1).ts + step;
  const alignedOi = oi.filter(point => point.ts >= firstClose && point.ts <= lastClose);
  if (alignedOi.length < 2) return missing('K线与持仓量序列缺少可对齐的时段。');
  const priceStep = priceIncrement(prices.at(-1).close);
  const sampleStride = Math.max(1, Math.ceil(prices.length / 240));
  const cells = [];
  let maxRawScore = 0;
  let positions = [];
  let levels = [];
  let nextOi = 1;
  let knownClose = null;
  let nextClose = 0;

  for (const [index, candle] of prices.entries()) {
    const ts = candle.ts + step;
    let added = false;
    if (index > 0 && candle.ts - prices[index - 1].ts > 1.5 * step) {
      positions = [];
      coverage.candleGaps++;
    }
    positions = positions.filter(position => position.side === 'long'
      ? candle.low > position.threshold
      : candle.high < position.threshold);

    while (nextOi < alignedOi.length && alignedOi[nextOi].ts <= ts) {
      const point = alignedOi[nextOi];
      const prior = alignedOi[nextOi - 1];
      nextOi++;

      while (nextClose < prices.length && prices[nextClose].ts + step <= point.ts) {
        knownClose = prices[nextClose];
        nextClose++;
      }
      if (!knownClose || ts - knownClose.ts > 2 * step || point.ts - prior.ts > 2.5 * oiStep) {
        coverage.gapsSkipped++;
        continue;
      }

      coverage.matchedChanges++;
      coverage.startsAt ??= prior.ts;
      coverage.endsAt = point.ts;
      const change = point.value - prior.value;
      if (change < 0) {
        const retained = point.value / prior.value;
        positions = positions.map(position => ({ ...position, amount: position.amount * retained }))
          .filter(position => position.amount > 0);
      }
      if (change > 0) {
        coverage.positiveChanges++;
        added = true;
        for (const tier of tiers) {
          for (const side of ['long', 'short']) {
            positions.push({
              side,
              threshold: projectedPrice(knownClose.close, tier, marginRate, side),
              amount: change / tiers.length,
            });
          }
        }
      }
    }

    const final = index === prices.length - 1;
    if (index % sampleStride !== 0 && !final && !added) continue;
    const byPrice = new Map();
    for (const position of positions) {
      const bucket = Math.floor(position.threshold / priceStep);
      const key = `${position.side}:${bucket}`;
      if (!byPrice.has(key)) byPrice.set(key, { side: position.side, bucket, rawScore: 0 });
      byPrice.get(key).rawScore += position.amount;
    }
    const snapshot = [...byPrice.values()].map(({ side, bucket, rawScore }) => {
      maxRawScore = Math.max(maxRawScore, rawScore);
      return {
        ts, side, price: Number((bucket * priceStep).toPrecision(12)),
        priceHigh: Number(((bucket + 1) * priceStep).toPrecision(12)), rawScore,
      };
    });
    cells.push(...snapshot);
    if (final) levels = snapshot;
  }

  if (!maxRawScore) return missing(coverage.matchedChanges
    ? '可对齐区间内没有供模型推算的新增仓位。'
    : '没有可在设定周期内配对的连续持仓变化。');

  let low = Infinity;
  let high = -Infinity;
  for (const cell of cells) {
    low = Math.min(low, cell.price);
    high = Math.max(high, cell.priceHigh);
    cell.intensity = cell.rawScore / maxRawScore;
  }
  levels.sort((a, b) => b.intensity - a.intensity || a.price - b.price);
  return {
    ...common, quality: 'estimated', reason: null, coverage, cells, levels,
    priceStep, priceRange: [low, high], maxRawScore,
  };
}
