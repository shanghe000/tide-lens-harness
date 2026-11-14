const endpoint = 'https://api.hyperliquid.xyz/info';
const documentation = 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint';
const hourMs = 3_600_000;
const maximumPages = 47;
const apiFillRetention = 10_000;
const pageSize = 500;
const scale = 10n ** 18n;

const asIso = (timestamp) => timestamp == null ? null : new Date(timestamp).toISOString();
const isTimestamp = (timestamp) => Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= 8.64e15;
const inMainPerps = (symbol) => typeof symbol === 'string' && symbol.length > 0 && !/[:/@#+]/.test(symbol);

function asNumber(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function units(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const pieces = /^(-?)(\d{1,36})(?:\.(\d{1,18}))?$/.exec(String(raw).trim());
  if (!pieces) return null;
  const magnitude = BigInt(pieces[2]) * scale + BigInt((pieces[3] || '').padEnd(18, '0'));
  return pieces[1] ? -magnitude : magnitude;
}

const quantity = (value) => value == null ? null : Number(value) / Number(scale);

async function info(fetchImpl, payload, signal) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload), signal,
    });
  } catch {
    throw new Error('Hyperliquid 连接超时或不可用。');
  }
  if (!response.ok) throw new Error(response.status === 429 ? 'Hyperliquid 请求限速。' : `Hyperliquid 查询失败（${response.status}）。`);
  try { return await response.json(); }
  catch { throw new Error('Hyperliquid 返回了无法读取的数据。'); }
}

function fillIdentity(row) {
  return JSON.stringify([row.time, row.coin, row.tid, row.oid, row.side, row.startPosition, row.px, row.sz]);
}

function fundingIdentity(row) {
  return JSON.stringify([row.time, row.hash, row.delta?.coin, row.delta?.szi, row.delta?.usdc, row.delta?.fundingRate]);
}

/** Split full inclusive ranges into disjoint ranges; never skip the final timestamp of a capped page. */
async function readHistory({ fetchImpl, user, start, end, type, signal, identity }) {
  const pending = [[start, end]];
  const reasons = new Set();
  const capReasons = new Set();
  const rows = new Map();
  const incomplete = [];
  let completed = 0;
  let pages = 0;
  while (pending.length && pages < maximumPages) {
    const [begin, until] = pending.pop();
    pages += 1;
    let page;
    try {
      const extra = type === 'userFillsByTime' ? { aggregateByTime: false } : {};
      page = await info(fetchImpl, { type, user, startTime: begin, endTime: until, ...extra }, signal);
      if (!Array.isArray(page)) throw new Error('Hyperliquid 历史数据格式异常。');
    } catch (error) {
      reasons.add(error.message);
      incomplete.push([begin, until, error.message]);
      if (signal.aborted) break;
      continue;
    }
    const bounded = page.filter((row) => row && isTimestamp(row.time) && row.time >= begin && row.time <= until);
    if (bounded.length !== page.length) {
      const reason = '交易所返回了时间无效或超出查询区间的记录。';
      reasons.add(reason);
      incomplete.push([begin, until, reason]);
    }
    for (const row of bounded) rows.set(identity(row), row);
    if (page.length < pageSize) { completed += 1; continue; }
    if (begin === until) {
      const reason = '同一毫秒的记录达到分页限制，无法确认该时间点已完整读取。';
      capReasons.add(reason);
      incomplete.push([begin, until, reason]);
      continue;
    }
    const times = bounded.map((row) => row.time).sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    // Dense pages can span only milliseconds. Split by the observed distribution, then
    // isolate a colliding timestamp rather than walking an otherwise empty interval.
    let split = begin + Math.floor((until - begin) / 2);
    if (median != null) split = times[0] === times.at(-1) ? median - 1 : median;
    split = Math.max(begin, Math.min(until - 1, split));
    pending.push([begin, split], [split + 1, until]);
  }
  if (pending.length) {
    const reason = '在本次请求预算内无法读取所有分页。';
    capReasons.add(reason);
    for (const [begin, until] of pending) incomplete.push([begin, until, reason]);
  }
  const result = [...rows.values()].sort((a, b) => a.time - b.time);
  if (type === 'userFillsByTime' && rows.size >= apiFillRetention) {
    const reason = '查询触及平台最多保留最近 10,000 笔成交的限制。';
    capReasons.add(reason);
    incomplete.push([start, result[0].time, reason]);
  }
  const insufficient = reasons.size > 0 || capReasons.size > 0;
  return {
    rows: result,
    coverage: {
      status: insufficient ? result.length || completed ? 'partial' : 'missing' : 'available',
      reason: [...reasons, ...capReasons].join('；') || null,
      capped: capReasons.size > 0,
      rows: result.length,
      pages,
      since: asIso(insufficient ? result[0]?.time : start),
      until: asIso(insufficient ? result.at(-1)?.time : end),
      missingRanges: incomplete.map(([begin, until, reason]) => ({ start: asIso(begin), end: asIso(until), reason })),
    },
  };
}

async function readCheckpoint(fetchImpl, user, now, signal) {
  try {
    const value = await info(fetchImpl, { type: 'clearinghouseState', user }, signal);
    if (!Array.isArray(value?.assetPositions) || !isTimestamp(value.time)) throw new Error('官方当前仓位快照缺少有效时间或仓位。');
    if (value.time < now - 90_000 || value.time > now + 90_000) throw new Error('官方当前仓位快照时间与查询时间相差超过 90 秒。');
    const positions = new Map();
    for (const item of value.assetPositions) {
      const { coin, szi } = item?.position || {};
      if (!inMainPerps(coin)) continue;
      const signed = units(szi);
      if (signed == null || positions.has(coin)) throw new Error('官方当前仓位快照出现无效或重复的合约数量。');
      positions.set(coin, { signed, raw: { coin, szi, time: value.time } });
    }
    return { status: 'available', timestamp: value.time, reason: null, positions };
  } catch (error) {
    return { status: 'missing', timestamp: null, reason: error.message, positions: new Map() };
  }
}

function action(before, after) {
  if (before === 0n) return 'open';
  if (after === 0n) return 'close';
  if ((before < 0n) !== (after < 0n)) return 'flip';
  return (before < 0n ? after < before : after > before) ? 'add' : 'reduce';
}

function parseFill(row) {
  const price = asNumber(row.px);
  const size = units(row.sz);
  const before = units(row.startPosition);
  const multiplier = row.side === 'B' ? 1n : row.side === 'A' ? -1n : null;
  if (price == null || price <= 0 || size == null || size <= 0n || before == null || multiplier == null) return null;
  const notional = price * quantity(size);
  if (!Number.isFinite(notional)) return null;
  return { row, price, size, before, after: before + size * multiplier, notional };
}

/** Use signed inventory continuity to order fills within a timestamp. Refuse ambiguous paths. */
function orderBlock(block, previous) {
  if (block.length === 1) return block;
  const byStart = new Map();
  const ending = new Set(block.map((fill) => fill.after));
  for (const fill of block) {
    if (byStart.has(fill.before)) return null;
    byStart.set(fill.before, fill);
  }
  const roots = block.filter((fill) => !ending.has(fill.before));
  const root = roots.length === 1 ? roots[0] : roots.length === 0 ? byStart.get(previous) : null;
  if (!root) return null;
  const ordered = [];
  let next = root;
  while (next) {
    ordered.push(next);
    byStart.delete(next.before);
    next = byStart.get(next.after);
  }
  return ordered.length === block.length ? ordered : null;
}

function eventFor(fill, id) {
  const { row, price, size, before, after, notional } = fill;
  return {
    id,
    timestamp: asIso(row.time),
    symbol: row.coin,
    side: row.side === 'B' ? 'buy' : 'sell',
    quantity: quantity(size),
    signedBefore: quantity(before),
    signedAfter: quantity(after),
    price,
    notional,
    action: action(before, after),
    closedPnl: asNumber(row.closedPnl),
    fee: asNumber(row.fee),
    feeToken: typeof row.feeToken === 'string' ? row.feeToken.trim() : null,
    quality: 'measured',
    raw: {
      coin: row.coin, time: row.time, side: row.side, px: row.px, sz: row.sz,
      startPosition: row.startPosition, dir: row.dir, closedPnl: row.closedPnl, fee: row.fee,
      feeToken: row.feeToken, crossed: row.crossed,
    },
  };
}

function point(timestamp, signed, quality, kind, extra) {
  return { timestamp: asIso(timestamp), signedQuantity: quantity(signed), quality, kind, ...extra };
}

function rebuildPosition(symbol, blocks, current, start, end, fillsAvailable, incomplete, events, gaps) {
  const points = [];
  let previous = null;
  let previousTime = start;
  let fillCount = 0;
  let initial = null;
  const addGap = (from, to, reason) => {
    gaps.push({ symbol, start: asIso(from), end: asIso(to), reason });
    points.push(point(to, null, 'missing', 'gap', { reason }));
  };
  for (const [time, block] of blocks) {
    if (previous != null && incomplete.some((range) => range.start <= time && range.end >= previousTime)) {
      addGap(previousTime, time, '这里的成交历史覆盖不完整，无法连接到下一次读数。');
      previous = null;
    }
    const ordered = orderBlock(block, previous);
    if (!points.length) {
      if (fillsAvailable && ordered) initial = ordered[0].before;
      points.push(point(start, initial, initial == null ? 'missing' : 'reconstructed', 'range-start'));
    }
    if (!ordered) {
      addGap(previousTime, time, '同一毫秒内的成交无法唯一排序。');
      for (const fill of block) events.push(eventFor(fill, `${symbol}:${time}:${fillCount++}`));
      previous = null;
      previousTime = time;
      continue;
    }
    if (previous != null && previous !== ordered[0].before) addGap(previousTime, time, '相邻成交的持仓数量不连续。');
    for (const fill of ordered) {
      const event = eventFor(fill, `${symbol}:${time}:${fillCount++}`);
      events.push(event);
      points.push(point(time, fill.before, 'measured', 'before-fill', { eventId: event.id }));
      points.push(point(time, fill.after, 'reconstructed', 'after-fill', { eventId: event.id }));
    }
    previous = ordered.at(-1).after;
    previousTime = time;
  }
  if (!points.length) {
    if (current && fillsAvailable) initial = current.signed;
    points.push(point(start, initial, initial == null ? 'missing' : 'reconstructed', 'range-start'));
  }
  if (current) {
    if (previous != null && current.signed !== previous) addGap(previousTime, end, '最后一笔成交推算仓位与官方期末快照不一致。');
    if (!fillsAvailable && previousTime !== end) addGap(previousTime, end, '成交历史只覆盖部分记录，期末仓位以独立快照为准。');
    points.push(point(end, current.signed, 'measured', 'current', { raw: current.raw }));
  } else {
    points.push(point(end, null, 'missing', 'range-end', { reason: '缺少官方期末仓位快照。' }));
  }
  return { symbol, initialQuantity: quantity(initial), finalQuantity: quantity(current?.signed), fills: fillCount, points };
}

function fundingEvents(result) {
  const events = [];
  let malformed = 0;
  for (const row of result.rows) {
    const body = row.delta;
    if (!body || body.type !== 'funding') { malformed += 1; continue; }
    if (!inMainPerps(body.coin)) continue;
    const amount = asNumber(body.usdc);
    const rate = asNumber(body.fundingRate);
    const signed = units(body.szi);
    if (amount == null || rate == null || signed == null || !Number.isFinite(rate * 100)) { malformed += 1; continue; }
    events.push({
      id: `funding:${body.coin}:${row.time}:${events.length}`,
      timestamp: asIso(row.time),
      symbol: body.coin,
      signedQuantity: quantity(signed),
      amount,
      ratePct: rate * 100,
      quality: 'measured',
      raw: { time: row.time, coin: body.coin, szi: body.szi, usdc: body.usdc, fundingRate: body.fundingRate },
    });
  }
  const coverage = { ...result.coverage, included: events.length };
  if (malformed) {
    coverage.status = events.length ? 'partial' : 'missing';
    coverage.reason = [coverage.reason, '部分资金费记录字段无效，已跳过。'].filter(Boolean).join('；');
  }
  return { events, coverage };
}

/** Read only the supplied address, using documented public Hyperliquid endpoints. */
export async function loadWhaleHistory(address, { hours = 24, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const user = typeof address === 'string' ? address.trim().toLowerCase() : '';
  if (!/^0x[\da-f]{40}$/.test(user)) throw new Error('请输入 0x 开头的 42 字符公开钱包地址。');
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new RangeError('历史窗口需为 1–168 小时的整数。');
  if (!isTimestamp(now) || now <= hours * hourMs) throw new RangeError('历史查询时间无效。');
  const signal = AbortSignal.timeout(12_000);
  const snapshot = await readCheckpoint(fetchImpl, user, now, signal);
  const end = snapshot.timestamp ?? now;
  const start = end - hours * hourMs;
  const shared = { fetchImpl, user, start, end, signal };
  const [fills, funding] = await Promise.all([
    readHistory({ ...shared, type: 'userFillsByTime', identity: fillIdentity }),
    readHistory({ ...shared, type: 'userFunding', identity: fundingIdentity }),
  ]);
  // An empty result can be legitimate. An upstream read failure returns explicit missing coverage.
  const bySymbol = new Map();
  const invalidTimes = [];
  let malformed = 0;
  for (const row of fills.rows) {
    if (typeof row.coin !== 'string' || !row.coin.length) { malformed += 1; invalidTimes.push(row.time); continue; }
    if (!inMainPerps(row.coin)) continue;
    const fill = parseFill(row);
    if (!fill) { malformed += 1; invalidTimes.push(row.time); continue; }
    if (!bySymbol.has(row.coin)) bySymbol.set(row.coin, new Map());
    const blocks = bySymbol.get(row.coin);
    if (!blocks.has(row.time)) blocks.set(row.time, []);
    blocks.get(row.time).push(fill);
  }
  for (const symbol of snapshot.positions.keys()) if (!bySymbol.has(symbol)) bySymbol.set(symbol, new Map());
  const fillsAvailable = fills.coverage.status === 'available' && !malformed;
  const events = [];
  const gaps = [];
  const missingRanges = [...fills.coverage.missingRanges, ...invalidTimes.map((time) => ({ start: asIso(time), end: asIso(time), reason: '该时点的成交字段无效。' }))];
  const incomplete = missingRanges.map((range) => ({ start: Date.parse(range.start), end: Date.parse(range.end) }));
  const positions = [...bySymbol.keys()].sort().map((symbol) => {
    const current = snapshot.status === 'available' ? snapshot.positions.get(symbol) ?? { signed: 0n, raw: { coin: symbol, szi: '0', time: end, absent: true } } : null;
    return rebuildPosition(symbol, bySymbol.get(symbol), current, start, end, fillsAvailable, incomplete, events, gaps);
  });
  const reason = [
    fills.coverage.reason,
    malformed ? '部分成交记录的价格、数量或方向无效，已跳过。' : null,
    snapshot.reason,
    gaps.length ? '检测到仓位连续性缺口，缺口不参与重建。' : null,
  ].filter(Boolean).join('；') || null;
  const coverage = {
    ...fills.coverage,
    status: !reason ? 'available' : events.length || snapshot.status === 'available' ? 'partial' : 'missing',
    reason,
    included: events.length,
    gaps,
    missingRanges,
    snapshot: { status: snapshot.status, timestamp: asIso(snapshot.timestamp), reason: snapshot.reason },
  };
  return {
    address: user,
    venue: 'Hyperliquid',
    start: asIso(start),
    end: asIso(end),
    loadedAt: asIso(now),
    positions,
    events: events.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.symbol.localeCompare(b.symbol)),
    funding: fundingEvents(funding),
    coverage,
    source: {
      url: endpoint,
      documentation,
      fundingDocumentation: `${documentation}/perpetuals#retrieve-a-users-funding-history-or-non-funding-ledger-updates`,
      method: '仅查询 Hyperliquid 主永续市场。成交前数量来自 startPosition，成交后数量由成交方向和数量计算，期末与官方当前仓位快照核对。历史受官方分页和保留范围限制。',
    },
  };
}
