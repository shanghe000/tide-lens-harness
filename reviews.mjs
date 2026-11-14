import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const idPattern = /^[a-f0-9]{64}$/;
const definitions = {
  price: { label: '最新成交价', unit: 'USDT' },
  change: { label: '24 小时涨跌幅', unit: '%' },
  oi: { label: '未平仓量', unit: '基础币' },
  oiUsd: { label: '未平仓名义价值', unit: 'USD' },
  funding: { label: '资金费率', unit: '比率' },
  longRatio: { label: '多空账户数之比', unit: '倍' },
};

function fingerprint(record) {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function normalizedSource(source) {
  if (typeof source === 'string') return { url: source };
  const clean = {};
  for (const key of ['url', 'label', 'method', 'quality', 'documentation', 'docs']) {
    if (typeof source?.[key] === 'string') clean[key] = source[key];
  }
  return Object.keys(clean).length ? clean : null;
}

export function makeFact({key,venue,symbol,asOf,label,unit,value,quality,source,context=null}) {
  if (!Number.isFinite(value) || !Number.isFinite(asOf) || !['measured','estimated'].includes(quality)) return null;
  const record = { key, venue, symbol, asOf, label, unit, value, quality, source:normalizedSource(source), context };
  return {id:fingerprint(record),...record};
}

export function factForMarket(market, key) {
  if (typeof key !== 'string') return null;
  const [category, detail, reference] = key.split(':');
  let definition;
  let source;
  let timestamp = market.asOf;
  let value;
  let quality;
  let context = null;

  if (Object.hasOwn(definitions, key)) {
    definition = definitions[key];
    value = market.metrics?.[key];
    source = market.sources?.[key];
    timestamp = market.metricsTimes?.[key] ?? market.asOf;
  } else if (category === 'candle') {
    const candle = market.candles?.find(item => item.ts === Number(detail));
    definition = {label: 'K 线收盘价', unit: 'USDT'};
    value = candle?.close;
    timestamp = candle?.ts;
    source = market.sources?.candles;
    if (candle) context = candle;
  } else if (category === 'series' && Object.hasOwn(definitions, detail)) {
    const point = market.series?.[detail]?.find(item => item.ts === Number(reference));
    definition = definitions[detail];
    value = point?.value;
    timestamp = point?.ts;
    source = market.sources?.[`${detail}History`] ?? market.sources?.[detail];
  } else if (category === 'model' && ['long', 'short'].includes(detail)) {
    const model = market.model ?? market.projection;
    const level = model?.levels?.find(item => item.side === detail && item.price === Number(reference));
    definition = { label: detail === 'long' ? '多头清算模型热度' : '空头清算模型热度', unit: '相对强度' };
    value = level?.intensity;
    timestamp = level?.ts;
    quality = 'estimated';
    source = { ...model?.source, method: model?.method, quality };
    if (level) context = {
      side: level.side, price: level.price, priceHigh: level.priceHigh, rawScore: level.rawScore,
      leverage: model.leverage, marginRate: model.marginRate, coverage: model.coverage,
      inputs: {
        candles: normalizedSource(model.inputs?.candles),
        openInterest: normalizedSource(model.inputs?.openInterest),
      },
    };
  } else if (category === 'book' && ['bid', 'ask'].includes(detail)) {
    const side = detail === 'bid' ? 'bids' : 'asks';
    const row = market.book?.[side]?.find(item => item.price === Number(reference));
    definition = { label: detail === 'bid' ? '买盘单价挂单名义价值' : '卖盘单价挂单名义价值', unit: 'USDT' };
    value = row?.notional;
    timestamp = market.book?.ts;
    source = market.sources?.book;
    if (row) context = { side: detail, price: row.price, size: row.size };
  } else if (category === 'trade' || category === 'liquidation') {
    const field = category === 'trade' ? 'trades' : 'liquidations';
    const record = market[field]?.find(item => String(item.id) === key.slice(category.length + 1));
    definition = { label: category === 'trade' ? '逐笔成交名义价值' : '已公布强平名义价值', unit: 'USDT' };
    value = record?.notional;
    timestamp = record?.ts;
    source = market.sources?.[field];
    if (record) context = { side: record.side, price: record.price, size: record.size, ...(record.raw && {raw:record.raw}) };
  }

  if (!definition || !Number.isFinite(value) || !Number.isFinite(timestamp)) return null;
  if (!quality) quality = source?.quality === 'estimated' ? 'estimated' : 'measured';
  if (source?.quality === 'missing') return null;
  return makeFact({key, venue:market.venue, symbol:market.symbol, asOf:timestamp,
    ...definition,value,quality,source,context});
}

function verifyFact(fact) {
  if (!fact || !idPattern.test(fact.id) || !Number.isFinite(fact.value) ||
      !Number.isFinite(fact.asOf) || !['measured', 'estimated'].includes(fact.quality)) {
    throw new TypeError('缺少有效、可核对的数据观察值。');
  }
  const { id, ...record } = fact;
  if (fingerprint(record) !== id) throw new TypeError('观察值已更新，请重新核对。');
}

function normalizeDecision(value) {
  if (value === true || value === 'approve' || value === 'approved') return 'approved';
  if (value === false || value === 'revoke' || value === 'revoked') return 'revoked';
  if (value === 'reject' || value === 'rejected') return 'rejected';
  throw new TypeError('请选择确认、拒绝或撤回。');
}

export function createReviews(dataDirectory) {
  const folder = join(dataDirectory, 'reviews');

  async function list() {
    let entries;
    try {
      entries = await readdir(folder, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || !idPattern.test(entry.name.slice(0, -5))) continue;
      try {
        const record = JSON.parse(await readFile(join(folder, entry.name), 'utf8'));
        verifyFact(record.fact);
        if (entry.name === `${record.fact.id}.json` &&
            ['approved', 'rejected', 'revoked'].includes(record.decision) && typeof record.decidedAt === 'string') {
          records.push(record);
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError || error instanceof TypeError)) throw error;
      }
    }
    return records.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt) || a.fact.id.localeCompare(b.fact.id));
  }

  async function set(fact, decision) {
    verifyFact(fact);
    const record = { fact, decision: normalizeDecision(decision), decidedAt: new Date().toISOString() };
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = join(folder, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(folder, `${fact.id}.json`));
    } finally {
      await rm(temporary, { force: true });
    }
    return record;
  }

  async function approved({ ids } = {}) {
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && idPattern.test(id)))) {
      throw new TypeError('已确认观察值的 ID 格式不正确。');
    }
    const selection = ids === undefined ? null : new Set(ids);
    return (await list()).filter(({ fact, decision }) => decision === 'approved' && (!selection || selection.has(fact.id)))
      .map(({ fact }) => fact);
  }

  return { list, set, approved };
}
