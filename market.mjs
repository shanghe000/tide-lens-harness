const OKX = 'https://openapi.okx.com';
const BINANCE = 'https://fapi.binance.com';
const BYBIT = 'https://api.bybit.com';
const MINUTE = 60_000;

// [window in minutes, candle interval in minutes, positioning interval in minutes]
const windows = {
  '1h': [60, 1, 5], '4h': [240, 1, 5], '12h': [720, 5, 15], '24h': [1440, 5, 15],
  '3d': [4320, 15, 60], '7d': [10080, 60, 240], '14d': [20160, 120, 240], '30d': [43200, 240, 1440],
};
const venues = new Set(['okx', 'binance', 'bybit']);
const metricNames = ['price', 'change', 'oi', 'oiUsd', 'funding', 'longRatio'];
const seriesNames = ['oi', 'oiUsd', 'funding', 'longRatio'];
const downloadCache = new Map();

function number(raw) {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function changeRate(last, open) {
  return last !== null && open > 0 ? 100 * (last / open - 1) : null;
}

function multiply(left, right) {
  return left !== null && right !== null ? left * right : null;
}

function urlFor(origin, path, params) {
  const query = new URLSearchParams(params);
  return `${origin}${path}${query.size ? `?${query}` : ''}`;
}

function spec(origin, path, params, label, method, quality = 'measured') {
  return { url: urlFor(origin, path, params), label, method, quality };
}

async function getJson(url) {
  const current = Date.now();
  for (const [key, cached] of downloadCache) {
    if (cached.expires <= current) downloadCache.delete(key);
  }
  const cached = downloadCache.get(url);
  if (cached) return cached.promise;
  const promise = (async () => {
    let response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(8500), redirect: 'error', headers: { accept: 'application/json' },
      });
    } catch (error) {
      throw new Error(error.name === 'TimeoutError' ? '公共行情请求超时' : '连接不到交易所公共行情服务', { cause: error });
    }
    if (!response.ok) throw new Error(`交易所返回 HTTP ${response.status}`);
    try {
      return await response.json();
    } catch (error) {
      throw new Error('交易所响应不是有效的行情数据', { cause: error });
    }
  })();
  const entry = { expires: current + 9000, promise };
  downloadCache.set(url, entry);
  promise.catch(() => {
    if (downloadCache.get(url) === entry) downloadCache.delete(url);
  });
  return promise;
}

function exchangeError(code) {
  const cleanCode = String(code ?? '').match(/^-?\d+$/)?.[0];
  return new Error(cleanCode ? `交易所拒绝该行情请求（${cleanCode}）` : '行情响应缺少预期格式');
}

async function requestVenue(venue, url) {
  const payload = await getJson(url);
  if (venue === 'okx') {
    if (payload?.code !== '0' || !Array.isArray(payload.data)) throw exchangeError(payload?.code);
    return { data: payload.data, time: null };
  }
  if (venue === 'bybit') {
    if (payload?.retCode !== 0 || !payload.result || typeof payload.result !== 'object') throw exchangeError(payload?.retCode);
    return { data: payload.result.list ?? payload.result, time: number(payload.time) };
  }
  if (!payload || typeof payload !== 'object' || number(payload.code) < 0) throw exchangeError(payload?.code);
  return { data: payload, time: null };
}

function intervalLabel(minutes, venue) {
  if (venue === 'bybit') return String(minutes);
  if (minutes >= 1440) return venue === 'okx' ? '1Dutc' : '1d';
  if (minutes >= 60) return `${minutes / 60}${venue === 'okx' ? 'H' : 'h'}`;
  return `${minutes}m`;
}

function bybitPeriod(minutes) {
  if (minutes >= 1440) return '1d';
  return minutes >= 60 ? `${minutes / 60}h` : `${minutes}min`;
}

function candle(row, venue, bar, asOf) {
  if (!Array.isArray(row)) return null;
  const [ts, open, high, low, close] = row.map(number);
  const volume = number(row[venue === 'okx' ? 6 : 5]);
  const confirmed = venue === 'okx' && row[8] !== undefined
    ? row[8] === '1' : ts + bar * MINUTE <= asOf;
  return ts > 0 && open > 0 && high > 0 && low > 0 && close > 0 && volume !== null
    ? { ts, open, high, low, close, volume, confirmed } : null;
}

function history(rows, parser, boundary) {
  const seen = new Map();
  for (const row of rows) {
    const point = parser(row);
    if (point && point.ts >= boundary) seen.set(point.ts, point);
  }
  return [...seen.values()].sort((first, second) => first.ts - second.ts);
}

function point(rawTs, rawValue) {
  const ts = number(rawTs);
  const value = number(rawValue);
  return ts > 0 && value !== null ? { ts, value } : null;
}

function trade(rawTs, rawPrice, rawSize, side, id) {
  const ts = number(rawTs);
  const price = number(rawPrice);
  const size = number(rawSize);
  if (!(ts > 0 && price > 0 && size > 0) || !side || id === null || id === undefined) return null;
  return { ts, price, size, notional: price * size, side, id: String(id) };
}

function bookSide(rows, factor) {
  return rows.flatMap(row => {
    const price = number(row[0]);
    const size = multiply(number(row[1]), factor);
    return price > 0 && size > 0 ? [{ price, size, notional: price * size }] : [];
  });
}

function book(ts, bids, asks, factor = 1) {
  const validBids = bookSide(Array.isArray(bids) ? bids : [], factor).sort((a, b) => b.price - a.price);
  const validAsks = bookSide(Array.isArray(asks) ? asks : [], factor).sort((a, b) => a.price - b.price);
  return { ts: number(ts), bids: validBids, asks: validAsks };
}

function fractionToRatio(long, short) {
  return long === null || !(short > 0) ? null : long / short;
}

function okxEndpoints(symbol, bar, period, count) {
  const instId = `${symbol}-USDT-SWAP`;
  const pair = { instId };
  const positioning = { instId, period: intervalLabel(period, 'okx'), limit: '100' };
  return {
    ticker: spec(OKX, '/api/v5/market/ticker', pair, 'OKX 永续行情', '最新成交价与滚动 24 小时开盘价。'),
    instruments: spec(OKX, '/api/v5/public/instruments', { instType: 'SWAP', ...pair }, 'OKX 合约规格', '以 ctVal × ctMult 将张数换算为标的币数量。'),
    candles: spec(OKX, '/api/v5/market/candles', { instId, bar: intervalLabel(bar, 'okx'), limit: count }, 'OKX 永续 K 线', '成交价 OHLC，成交量为标的币数量。可含未收盘柱。'),
    interest: spec(OKX, '/api/v5/public/open-interest', { instType: 'SWAP', ...pair }, 'OKX 当前持仓量', '单合约 oiCcy（标的币）和 oiUsd（美元等值）。'),
    interestHistory: spec(OKX, '/api/v5/rubik/stat/contracts/open-interest-history', positioning, 'OKX 历史持仓量', '单合约 oiCcy 和 oiUsd，按交易所时间点返回。'),
    funding: spec(OKX, '/api/v5/public/funding-rate', pair, 'OKX 当前资金费率', '交易所发布的本期 fundingRate，小数。'),
    fundingHistory: spec(OKX, '/api/v5/public/funding-rate-history', { instId, limit: '100' }, 'OKX 历史资金费率', '最近最多 100 个实际结算点的 realizedRate，小数。'),
    longRatioHistory: spec(OKX, '/api/v5/rubik/stat/contracts/long-short-account-ratio-contract', positioning, 'OKX 多空账户数比', '该合约净多账户数 ÷ 净空账户数，单位为倍。'),
    ...(period > 5 && { latestLongRatio: spec(OKX, '/api/v5/rubik/stat/contracts/long-short-account-ratio-contract', { instId, period: '5m', limit: '2' }, 'OKX 近期多空账户数比', '最近 5 分钟采样点，净多账户数 ÷ 净空账户数。') }),
    trades: spec(OKX, '/api/v5/market/trades', { instId, limit: '100' }, 'OKX 最近成交', '最多 100 条近期成交。主动方由交易所 side 字段给出；成交额按成交价 × 标的币数量。'),
    book: spec(OKX, '/api/v5/market/books', { instId, sz: '100' }, 'OKX 实时盘口', '每侧最多 100 档挂单价格与数量的单次快照。'),
    liquidations: spec(OKX, '/api/v5/public/liquidation-orders', { instType: 'SWAP', uly: `${symbol}-USDT`, state: 'filled', limit: '100' },
      'OKX 最近公开强平', '最多 100 条公开样本。价格是清算系统接管价 bkPx；金额是接管价 × 数量。该旧入口不承诺长期支持与覆盖完整。'),
  };
}

function binanceEndpoints(symbol, bar, period, count) {
  const pair = { symbol: `${symbol}USDT` };
  const positioning = { ...pair, period: intervalLabel(period, 'binance'), limit: '100' };
  return {
    ticker: spec(BINANCE, '/fapi/v1/ticker/24hr', pair, 'Binance USDⓈ-M 永续行情', '最新成交价与交易所滚动 24 小时涨跌幅。'),
    candles: spec(BINANCE, '/fapi/v1/klines', { ...pair, interval: intervalLabel(bar, 'binance'), limit: count }, 'Binance 永续 K 线', '成交价 OHLC，成交量为标的币数量。可含未收盘柱。'),
    interest: spec(BINANCE, '/fapi/v1/openInterest', pair, 'Binance 当前持仓量', '单合约标的币持仓量 openInterest。'),
    interestHistory: spec(BINANCE, '/futures/data/openInterestHist', positioning, 'Binance 历史持仓量', '该合约的 sumOpenInterest（标的币）和 sumOpenInterestValue（报价币等值）。'),
    funding: spec(BINANCE, '/fapi/v1/premiumIndex', pair, 'Binance 资金费率和标记价格', '交易所 lastFundingRate（小数）和 markPrice。'),
    fundingHistory: spec(BINANCE, '/fapi/v1/fundingRate', { ...pair, limit: '100' }, 'Binance 历史资金费率', '最近最多 100 个实际结算点的 fundingRate，小数。'),
    longRatioHistory: spec(BINANCE, '/futures/data/globalLongShortAccountRatio', positioning, 'Binance 多空账户数比', '该合约净多账户数 ÷ 净空账户数，单位为倍。'),
    ...(period > 5 && { latestLongRatio: spec(BINANCE, '/futures/data/globalLongShortAccountRatio', { ...pair, period: '5m', limit: '2' }, 'Binance 近期多空账户数比', '最近 5 分钟采样点，净多账户数 ÷ 净空账户数。') }),
    trades: spec(BINANCE, '/fapi/v1/trades', { ...pair, limit: '100' }, 'Binance 最近成交', '最多 100 条近期成交。买方为 maker 时，主动成交方为卖方。'),
    book: spec(BINANCE, '/fapi/v1/depth', { ...pair, limit: '100' }, 'Binance 实时盘口', '每侧最多 100 档挂单价格与数量的单次快照。'),
  };
}

function bybitEndpoints(symbol, bar, period, count) {
  const pair = { category: 'linear', symbol: `${symbol}USDT` };
  return {
    ticker: spec(BYBIT, '/v5/market/tickers', pair, 'Bybit USDT 永续行情', '最新成交价、24 小时变动、单边持仓量及价值、本期资金费率。'),
    candles: spec(BYBIT, '/v5/market/kline', { ...pair, interval: intervalLabel(bar, 'bybit'), limit: count }, 'Bybit 永续 K 线', '成交价 OHLC，成交量为标的币数量。可含未收盘柱。'),
    interestHistory: spec(BYBIT, '/v5/market/open-interest', { ...pair, intervalTime: bybitPeriod(period), limit: '100' }, 'Bybit 历史持仓量', '该合约单边持仓量 singleOpenInterest，单位为标的币。'),
    fundingHistory: spec(BYBIT, '/v5/market/funding/history', { ...pair, limit: '200' }, 'Bybit 历史资金费率', '最近最多 200 个实际结算点的 fundingRate，小数。'),
    longRatioHistory: spec(BYBIT, '/v5/market/account-ratio', { ...pair, period: bybitPeriod(period), limit: '100' }, 'Bybit 多空账户数比', '使用多头账户占比 buyRatio ÷ 空头账户占比 sellRatio，单位为倍。'),
    ...(period > 5 && { latestLongRatio: spec(BYBIT, '/v5/market/account-ratio', { ...pair, period: '5min', limit: '2' }, 'Bybit 近期多空账户数比', '最近 5 分钟采样点，多头账户占比 ÷ 空头账户占比。') }),
    trades: spec(BYBIT, '/v5/market/recent-trade', { ...pair, limit: '100' }, 'Bybit 最近成交', '最多 100 条近期成交，交易所标明主动方。'),
    book: spec(BYBIT, '/v5/market/orderbook', { ...pair, limit: '100' }, 'Bybit 实时盘口', '每侧最多 100 档挂单价格与数量的单次快照。'),
  };
}

const endpointsOf = { okx: okxEndpoints, binance: binanceEndpoints, bybit: bybitEndpoints };

function instrumentFactor(row, symbol) {
  if (row?.ctType !== 'linear' || row?.ctValCcy !== symbol) return null;
  const value = number(row.ctVal);
  const multiplier = number(row.ctMult) ?? 1;
  return value > 0 && multiplier > 0 ? value * multiplier : null;
}

function estimatedInterestValue(points, candles, bar) {
  let cursor = 0;
  let completed;
  const result = [];
  for (const { ts, value } of points) {
    while (cursor < candles.length && candles[cursor].ts + bar * MINUTE <= ts) {
      completed = candles[cursor];
      cursor++;
    }
    if (completed?.confirmed && ts - completed.ts <= bar * MINUTE * 2) result.push({ ts, value: value * completed.close });
  }
  return result;
}

function okxLiquidations(rows, symbol, factor) {
  const records = rows.find(row => row.instId === `${symbol}-USDT-SWAP`)?.details;
  const occurrences = new Map();
  return (Array.isArray(records) ? records : []).flatMap(row => {
    const key = [row.ts, row.bkPx, row.sz, row.side, row.posSide].join(':');
    const ordinal = occurrences.get(key) ?? 0;
    occurrences.set(key, ordinal + 1);
    const normalized = trade(row.ts, row.bkPx, multiply(number(row.sz), factor),
      ['long','short'].includes(row.posSide) ? row.posSide : row.side === 'sell' ? 'long' : row.side === 'buy' ? 'short' : null,
      `${key}:${ordinal}`);
    return normalized ? [{...normalized,raw:{ts:row.ts,bkPx:row.bkPx,sz:row.sz,side:row.side,posSide:row.posSide,contractFactor:factor}}] : [];
  });
}

export async function loadReplayTick({venue, symbol}) {
  if (!venues.has(venue) || typeof symbol !== 'string' || !/^[A-Z0-9]{1,20}$/u.test(symbol)) {
    throw new RangeError('交易所或币种无效');
  }
  const definition = endpointsOf[venue](symbol, 1, 5, '1');
  const entries = Object.entries(definition).filter(([name]) => ['book','instruments','liquidations'].includes(name));
  const result = { venue, symbol, book:null, liquidations:[], sources:{}, errors:{} };
  const payload = {};
  await Promise.all(entries.map(async ([name, source]) => {
    result.sources[name] = source;
    try { payload[name] = await requestVenue(venue, source.url); }
    catch (error) { result.errors[name] = error.message; }
  }));
  const snapshot = payload.book?.data;
  if (venue === 'okx') {
    const factor = instrumentFactor(first(payload.instruments?.data ?? []), symbol);
    const row = first(snapshot ?? []);
    if (snapshot && factor !== null) result.book = book(row.ts,row.bids,row.asks,factor);
    if (payload.liquidations && factor !== null) result.liquidations = okxLiquidations(payload.liquidations.data,symbol,factor);
    if (factor === null) {
      result.errors.book ??= '缺少 OKX 合约乘数，无法换算挂单数量';
      result.errors.liquidations ??= '缺少 OKX 合约乘数，无法换算强平数量';
    }
  } else if (snapshot) {
    result.book = venue === 'binance' ? book(snapshot.T ?? snapshot.E,snapshot.bids,snapshot.asks) :
      book(snapshot.cts ?? snapshot.ts ?? payload.book.time,snapshot.b,snapshot.a);
  }
  return result;
}

function missingSource(url, label, method) {
  return { url, label, method, quality: 'missing' };
}

const liquidationUnavailable = {
  binance: missingSource('https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Liquidation-Order-Streams',
    'Binance 强平 WebSocket', '公开流每秒推送单合约最新一笔；这个请求未连续记录实时流。'),
  bybit: missingSource('https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation',
    'Bybit 强平 WebSocket', '公开全量强平流需要在线订阅；这个请求未连续记录实时流。'),
};

function first(rows) {
  return Array.isArray(rows) ? rows[0] ?? {} : {};
}

function emptyMarket(venue, symbol, window, asOf) {
  return {
    venue, symbol, window, asOf, metrics: Object.fromEntries(metricNames.map(key => [key, null])),
    metricsTimes: Object.fromEntries(metricNames.map(key => [key, null])),
    candles: [], series: Object.fromEntries(seriesNames.map(key => [key, []])), trades: [],
    book: { ts: null, bids: [], asks: [] }, liquidations: [], sources: {}, errors: {},
  };
}

function mapMarket(result, payload, endpoint, boundary, bar) {
  const { venue, symbol, metrics, metricsTimes, series, sources, errors } = result;
  const rows = key => Array.isArray(payload[key]?.data) ? payload[key].data : [];
  const data = key => payload[key]?.data ?? {};
  const ticker = venue === 'binance' ? data('ticker') : first(rows('ticker'));

  function mark(key, origin, errorOrigin = origin) {
    if (endpoint[origin]) sources[key] = endpoint[origin];
    if (errors[errorOrigin]) errors[key] ??= errors[errorOrigin];
  }

  mark('price', 'ticker');
  mark('change', 'ticker');
  mark('fundingHistory', 'fundingHistory');
  mark('oiHistory', 'interestHistory');
  mark('oiUsdHistory', 'interestHistory');
  mark('longRatioHistory', 'longRatioHistory');
  mark('candles', 'candles');
  mark('trades', 'trades');
  mark('book', 'book');

  result.candles = history(rows('candles'), row => candle(row, venue, bar, result.asOf), boundary - bar * MINUTE + 1);
  let positions;
  let accountRatio;
  if (venue === 'okx') {
    const current = first(rows('interest'));
    const funding = first(rows('funding'));
    metrics.price = number(ticker.last);
    metrics.change = changeRate(metrics.price, number(ticker.open24h));
    metrics.oi = number(current.oiCcy);
    metrics.oiUsd = number(current.oiUsd);
    metrics.funding = number(funding.fundingRate);
    metricsTimes.price = metricsTimes.change = number(ticker.ts);
    metricsTimes.oi = metricsTimes.oiUsd = number(current.ts);
    metricsTimes.funding = number(funding.ts);
    mark('oi', 'interest');
    mark('oiUsd', 'interest');
    mark('funding', 'funding');
    positions = rows('interestHistory');
    series.oi = history(positions, row => point(row[0], row[2]), boundary);
    series.oiUsd = history(positions, row => point(row[0], row[3]), boundary);
    accountRatio = row => point(row[0], row[1]);
    series.funding = history(rows('fundingHistory'), row => point(row.fundingTime, row.realizedRate), boundary);

    const factor = instrumentFactor(first(rows('instruments')), symbol);
    sources.instruments = endpoint.instruments;
    const snapshot = first(rows('book'));
    result.book = book(snapshot.ts, snapshot.bids, snapshot.asks, factor);
    result.trades = rows('trades').map(row => trade(row.ts, row.px, multiply(number(row.sz), factor), row.side, row.tradeId)).filter(Boolean);
    result.liquidations = okxLiquidations(rows('liquidations'), symbol, factor);
    mark('liquidations', 'liquidations');
    if (factor === null) {
      const message = '合约规格不足以将订单张数换算成标的币数量';
      errors.trades ??= message;
      errors.book ??= message;
      errors.liquidations ??= message;
    }
  } else if (venue === 'binance') {
    const funding = data('funding');
    const current = data('interest');
    metrics.price = number(ticker.lastPrice);
    metrics.change = number(ticker.priceChangePercent);
    metrics.oi = number(current.openInterest);
    metrics.oiUsd = multiply(metrics.oi, number(funding.markPrice));
    metrics.funding = number(funding.lastFundingRate);
    metricsTimes.price = metricsTimes.change = number(ticker.closeTime);
    metricsTimes.oi = metricsTimes.oiUsd = number(current.time);
    metricsTimes.funding = number(funding.time);
    mark('oi', 'interest');
    mark('funding', 'funding');
    sources.oiUsd = { ...endpoint.interest, quality: 'estimated', label: 'Binance 当前持仓价值估算',
      method: `以当前标的币持仓量 × 标记价格估算报价币价值。标记价格来源：${endpoint.funding.url}` };
    if (metrics.oiUsd === null) errors.oiUsd = errors.interest ?? errors.funding;
    positions = rows('interestHistory');
    series.oi = history(positions, row => point(row.timestamp, row.sumOpenInterest), boundary);
    series.oiUsd = history(positions, row => point(row.timestamp, row.sumOpenInterestValue), boundary);
    accountRatio = row => point(row.timestamp, row.longShortRatio);
    series.funding = history(rows('fundingHistory'), row => point(row.fundingTime, row.fundingRate), boundary);
    result.trades = rows('trades').map(row => trade(row.time, row.price, row.qty,
      typeof row.isBuyerMaker === 'boolean' ? row.isBuyerMaker ? 'sell' : 'buy' : null, row.id)).filter(Boolean);
    const snapshot = data('book');
    result.book = book(snapshot.T ?? snapshot.E, snapshot.bids, snapshot.asks);
  } else {
    metrics.price = number(ticker.lastPrice);
    metrics.change = multiply(number(ticker.price24hPcnt), 100);
    metrics.oi = number(ticker.singleOpenInterest);
    metrics.oiUsd = number(ticker.singleOpenInterestValue);
    metrics.funding = number(ticker.fundingRate);
    metricsTimes.price = metricsTimes.change = metricsTimes.oi = metricsTimes.oiUsd = metricsTimes.funding = payload.ticker?.time ?? null;
    mark('oi', 'ticker');
    mark('oiUsd', 'ticker');
    mark('funding', 'ticker');
    positions = rows('interestHistory');
    series.oi = history(positions, row => point(row.timestamp, row.singleOpenInterest), boundary);
    series.oiUsd = estimatedInterestValue(series.oi, result.candles, bar);
    sources.oiUsdHistory = { ...endpoint.interestHistory, quality: 'estimated', label: 'Bybit 历史持仓价值估算',
      method: `历史单边持仓量 × 同时点之前最近已收盘的成交价，报价币为 USDT。K 线来源：${endpoint.candles.url}` };
    accountRatio = row => point(row.timestamp, fractionToRatio(number(row.buyRatio), number(row.sellRatio)));
    series.funding = history(rows('fundingHistory'), row => point(row.fundingRateTimestamp, row.fundingRate), boundary);
    result.trades = rows('trades').map(row => trade(row.time, row.price, row.size,
      row.side === 'Buy' ? 'buy' : row.side === 'Sell' ? 'sell' : null, row.execId)).filter(Boolean);
    const snapshot = data('book');
    result.book = book(snapshot.cts ?? snapshot.ts ?? payload.book?.time, snapshot.b, snapshot.a);
  }

  const ratios = history(rows('longRatioHistory'), accountRatio, 0);
  const latest = history(rows('latestLongRatio'), accountRatio, 0).at(-1);
  const currentRatio = latest ?? ratios.at(-1);
  metrics.longRatio = currentRatio?.value ?? null;
  metricsTimes.longRatio = currentRatio?.ts ?? null;
  sources.longRatio = latest ? endpoint.latestLongRatio : endpoint.longRatioHistory;
  if (!currentRatio) errors.longRatio ??= errors.latestLongRatio ?? errors.longRatioHistory;
  series.longRatio = ratios.filter(row => row.ts >= boundary);
  if (venue !== 'okx') {
    sources.liquidations = liquidationUnavailable[venue];
    errors.liquidations = sources.liquidations.method;
  }

  result.trades = result.trades.filter(row => row.ts >= boundary).sort((a, b) => b.ts - a.ts);
  result.liquidations = result.liquidations.filter(row => row.ts >= boundary).sort((a, b) => b.ts - a.ts);
  for (const key of metricNames) {
    if (metrics[key] === null) {
      errors[key] ??= '交易所未返回当前指标';
      metricsTimes[key] = null;
    }
  }
  for (const key of seriesNames) {
    if (!series[key].length) errors[`${key}History`] ??= key === 'funding' ? '此区间没有已返回的资金费率结算点' : '此区间没有可用记录';
  }
  const fundingLimit = Number(new URL(endpoint.fundingHistory.url).searchParams.get('limit'));
  if (series.funding.length >= fundingLimit) {
    sources.fundingHistory = { ...sources.fundingHistory, method: `${sources.fundingHistory.method}已达到单次返回上限，可能未覆盖完整时段。` };
  }
  if (!result.candles.length) errors.candles ??= '此区间没有可用 K 线';
  if (!result.trades.length) errors.trades ??= '近期样本没有覆盖此区间的成交';
  if (!result.book.bids.length && !result.book.asks.length) errors.book ??= '当前没有可用的公开盘口快照';
  if (!result.liquidations.length) errors.liquidations ??= '交易所近期样本未返回此区间的强平记录';
  for (const [key, source] of Object.entries(sources)) {
    if (errors[key]) sources[key] = { ...source, quality: 'missing' };
  }
}

export async function loadMarket({ venue = 'okx', symbol = 'BTC', window = '24h' } = {}) {
  const market = String(venue).trim().toLowerCase();
  const asset = String(symbol).trim().toUpperCase().replace(/-USDT-SWAP$|USDT$/u, '');
  if (!venues.has(market) || !/^[A-Z0-9]{1,20}$/u.test(asset) || !Object.hasOwn(windows, window)) {
    throw new RangeError('交易所、币种或时间范围无效');
  }
  const asOf = Date.now();
  const [minutes, bar, period] = windows[window];
  const boundary = asOf - minutes * MINUTE;
  const endpoint = endpointsOf[market](asset, bar, period, String(Math.min(300, Math.ceil(minutes / bar) + 2)));
  const result = emptyMarket(market, asset, window, asOf);
  const payload = {};
  const received = await Promise.allSettled(Object.values(endpoint).map(source => requestVenue(market, source.url)));
  Object.keys(endpoint).forEach((key, index) => {
    const response = received[index];
    if (response.status === 'fulfilled') payload[key] = response.value;
    else result.errors[key] = response.reason.message;
  });
  mapMarket(result, payload, endpoint, boundary, bar);
  return result;
}

function screenRow(symbol, price, change, volume, turnover, oi = null, oiUsd = null, funding = null) {
  return { symbol, price, change, volume, turnover, oi, oiUsd, funding };
}

function okxScreen(rows) {
  return rows.filter(row => /^[A-Z0-9]+-USDT-SWAP$/u.test(row.instId)).map(row => {
    const price = number(row.last);
    const volume = number(row.volCcy24h);
    return screenRow(row.instId.slice(0, -10), price, changeRate(price, number(row.open24h)), volume, multiply(volume, price));
  });
}

function binanceScreen(rows) {
  return rows.filter(row => /^[A-Z0-9]+USDT$/u.test(row.symbol)).map(row => screenRow(
    row.symbol.slice(0, -4), number(row.lastPrice), number(row.priceChangePercent), number(row.volume), number(row.quoteVolume),
  ));
}

function bybitScreen(rows) {
  return rows.filter(row => /^[A-Z0-9]+USDT$/u.test(row.symbol)).map(row => screenRow(
    row.symbol.slice(0, -4), number(row.lastPrice), multiply(number(row.price24hPcnt), 100), number(row.volume24h), number(row.turnover24h),
    number(row.singleOpenInterest), number(row.singleOpenInterestValue), number(row.fundingRate),
  ));
}

const screenEndpoints = {
  okx: [OKX, '/api/v5/market/tickers', { instType: 'SWAP' }, okxScreen, '成交额为 24 小时标的币成交量 × 最新价的近似值。'],
  binance: [BINANCE, '/fapi/v1/ticker/24hr', {}, binanceScreen, '成交额使用交易所 24 小时报价币成交量。'],
  bybit: [BYBIT, '/v5/market/tickers', { category: 'linear' }, bybitScreen, '成交额和单边持仓价值取自交易所行情。'],
};

const screenExtras = {
  okx: {
    source: spec(OKX, '/api/v5/public/open-interest', { instType: 'SWAP' }, 'OKX 永续持仓量', '全量永续合约的标的币持仓量和美元等值。'),
    keyOf: row => row.instId?.endsWith('-USDT-SWAP') ? row.instId.slice(0, -10) : null,
    fields: { oi: 'oiCcy', oiUsd: 'oiUsd' },
  },
  binance: {
    source: spec(BINANCE, '/fapi/v1/premiumIndex', {}, 'Binance 最近资金费率', '全量合约的 lastFundingRate，小数。'),
    keyOf: row => row.symbol?.endsWith('USDT') ? row.symbol.slice(0, -4) : null,
    fields: { funding: 'lastFundingRate' },
  },
};

async function screenRows(market, source) {
  const { data } = await requestVenue(market, source.url);
  if (!Array.isArray(data) || !data.length) throw new Error('交易所没有返回可用合约列表');
  return data;
}

export async function loadScreener({ venue = 'okx' } = {}) {
  const market = String(venue).trim().toLowerCase();
  if (!venues.has(market)) throw new RangeError('交易所无效');
  const [origin, path, params, normalize, method] = screenEndpoints[market];
  const source = spec(origin, path, params, `${market.toUpperCase()} USDT 永续筛选`, `交易所滚动 24 小时统计。${method}`);
  const result = { venue: market, asOf: Date.now(), rows: [], sources: { rows: source }, errors: {} };
  const extra = screenExtras[market];
  if (market === 'okx') result.sources.turnover = { ...source, quality: 'estimated' };
  const requested = [screenRows(market, source)];
  if (extra) requested.push(screenRows(market, extra.source));
  const [ticker, auxiliary] = await Promise.allSettled(requested);
  if (ticker.status === 'fulfilled') {
    result.rows = normalize(ticker.value).filter(row => row.price > 0 && row.change !== null).sort((a, b) => b.change - a.change);
  }
  if (!result.rows.length) {
    result.errors.rows = ticker.reason?.message ?? '此交易所没有返回可用行情';
    result.sources.rows = { ...source, quality: 'missing' };
  }
  if (extra && auxiliary.status === 'fulfilled') {
    const additions = new Map(auxiliary.value.map(row => [extra.keyOf(row), row]));
    for (const row of result.rows) {
      const match = additions.get(row.symbol);
      for (const [key, field] of Object.entries(extra.fields)) row[key] = number(match?.[field]);
    }
  }
  for (const key of ['oi', 'oiUsd', 'funding']) {
    const provided = market === 'bybit' ? source : extra?.fields[key] ? extra.source : null;
    if (provided && result.rows.some(row => row[key] !== null)) {
      result.sources[key] = provided;
    } else {
      result.errors[key] = provided ? auxiliary?.reason?.message ?? result.errors.rows ?? '未返回该指标'
        : '此交易所的公开批量筛选数据未提供此指标';
      result.sources[key] = { ...(provided ?? source), quality: 'missing', method: result.errors[key] };
    }
  }
  return result;
}
