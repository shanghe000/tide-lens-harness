const hlEndpoint = 'https://api.hyperliquid.xyz/info';
const hlDocs = 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals';
const bnEndpoint = 'https://fapi.binance.com/fapi/v1/';
const bnRatioEndpoint = 'https://fapi.binance.com/futures/data/globalLongShortAccountRatio';
const bnDocs = 'https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/';
const binancePreIpo = 'https://www.binance.com/en-IA/support/faq/detail/87bf29a506b647159fc6ace70d38f252';
const anthropicTerms = 'https://www.binance.com/en/support/announcement/detail/d5d3474a9b054f23a1867aff5cdece3f';
const xyzTerms = 'https://docs.trade.xyz/perpetuals/specifications-and-schedules/pre-ipo-specification-index.md';
const entropyTerms = 'https://docs.entropy.io/market-types/pre-ipo-perpetuals';
const metricKeys = ['markPrice', 'oraclePrice', 'changePct24h', 'volumeUsd', 'openInterest', 'openInterestUsd', 'fundingRatePct'];

const hlCategories = new Map([['stocks', 'equity'], ['stock', 'equity'], ['indices', 'index'], ['commodities', 'commodity'], ['fx', 'fx'], ['rates', 'rates'], ['preipo', 'pre-ipo']]);
const bnCategories = new Map([['EQUITY', 'equity'], ['KR_EQUITY', 'equity'], ['HK_EQUITY', 'equity'], ['CN_EQUITY', 'equity'], ['INDEX', 'index'], ['COMMODITY', 'commodity'], ['FX', 'fx'], ['RATES', 'rates']]);
const terms = new Map([
  ['binance:ANTHROPICUSDT', { label: 'Anthropic', basis: 'share-price', url: anthropicTerms, multiplier: 1_000_000_000, description: '币安 ANTHROPICUSDT 旧口径：标记价 × 10 亿股。仅适用改名或调整前的原合约。' }],
  ['binance:OPENAIUSDT', { label: 'OpenAI', basis: 'share-price', url: 'https://www.binance.com/en/support/announcement/detail/94f88766c6c84d68a07f006bc076ba6a' }],
  ['binance:OURAUSDT', { label: 'Oura', basis: 'share-price', url: 'https://www.binance.com/en/support/announcement/detail/8bd2b3a7684749bba472e71fc3ad8043' }],
  ['binance:MOONSHOTUSDT', { label: '月之暗面', basis: 'share-price', url: 'https://www.binance.com/en-ZA/support/announcement/detail/7379b99aa0f349a49c3b3feca1b4bbd6' }],
  ['hyperliquid:io:ANTH', { label: 'Anthropic', basis: 'company-valuation', url: entropyTerms, multiplier: 1_000_000_000, description: 'EntropyIO 预上市口径：每 1 报价单位对应 10 亿美元完全摊薄隐含估值。' }],
  ['hyperliquid:io:OAI', { label: 'OpenAI', basis: 'company-valuation', url: entropyTerms, multiplier: 1_000_000_000, description: 'EntropyIO 预上市口径：每 1 报价单位对应 10 亿美元完全摊薄隐含估值。' }],
  ['hyperliquid:xyz:ANT', { label: 'Anthropic', basis: 'share-price', url: xyzTerms }],
  ['hyperliquid:xyz:OURA', { label: 'Oura', basis: 'share-price', url: xyzTerms }],
]);

function number(value, { positive = false, nonnegative = false } = {}) {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') return null;
  const result = Number(value);
  if (!Number.isFinite(result) || (positive && result <= 0) || (nonnegative && result < 0)) return null;
  return result;
}
function multiply(a, b) {
  if (a == null || b == null) return null;
  return Number.isFinite(a * b) ? a * b : null;
}
function asIso(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8.64e15 ? new Date(value).toISOString() : null;
}
function timestamp() { return new Date().toISOString(); }

async function json(fetchImpl, url, payload) {
  const options = { signal: AbortSignal.timeout(6_500), headers: { Accept: 'application/json' } };
  if (payload) {
    options.method = 'POST';
    options.body = JSON.stringify(payload);
    options.headers['Content-Type'] = 'application/json';
  }
  const response = await fetchImpl(url, options);
  if (!response.ok) throw new Error(`行情接口返回 ${response.status}`);
  return response.json();
}

function source(label, url, documentation, method, quality = 'measured', raw = undefined) {
  return { label, url, documentation, method, quality, ...(raw === undefined ? {} : { raw }) };
}
function linksForBinance(field) {
  const docs = { info: 'Exchange-Information', ticker: '24hr-Ticker-Price-Change-Statistics', mark: 'Mark-Price', oi: 'Open-Interest' };
  const path = { info: 'exchangeInfo', ticker: 'ticker/24hr', mark: 'premiumIndex', oi: 'openInterest' };
  return { path: path[field], documentation: `${bnDocs}${docs[field]}` };
}
function sourceForBinance(field, symbol, method, quality, raw) {
  const { path, documentation } = linksForBinance(field);
  return source('Binance USDⓈ-M 永续', `${bnEndpoint}${path}${field === 'info' ? '' : `?symbol=${encodeURIComponent(symbol)}`}`, documentation, method, quality, raw);
}
function ratioUrl(symbol) { return `${bnRatioEndpoint}?symbol=${encodeURIComponent(symbol)}&period=5m&limit=1`; }
function hgSource(method, quality, raw) {
  return source('Hyperliquid HIP-3', hlEndpoint, hlDocs, method, quality, raw);
}
function field(value, item, emptyMessage) {
  return value == null ? { ...item, quality: 'missing', method: emptyMessage || '对应接口未提供有效字段。' } : item;
}

function assemble(row) {
  const reviewed = row.category === 'pre-ipo' ? terms.get(row.id) : null;
  const mark = row.markPrice;
  const impliedValuationUsd = multiply(mark, reviewed?.multiplier);
  const termsUrl = reviewed?.url ?? (row.category === 'pre-ipo' && row.venue === 'binance' ? binancePreIpo : null);
  const valuationExplanation = reviewed?.description ?? '当前合约未配置已核对的市值转换口径，保留原合约报价。';
  const valuationSource = source(row.venue === 'binance' ? 'Binance 合约公告' : row.dex === 'io' ? 'EntropyIO 合约说明' : row.source.label, termsUrl || row.source.documentation,
    termsUrl || row.source.documentation, valuationExplanation, impliedValuationUsd == null ? 'missing' : 'estimated', { markPrice: mark, multiplier: reviewed?.multiplier ?? null });
  return {
    ...row,
    label: reviewed?.label ?? row.label,
    instrumentType: 'synthetic-perpetual',
    quoteBasis: reviewed?.basis ?? (row.category === 'pre-ipo' ? 'unspecified' : 'perpetual-reference'),
    termsUrl,
    impliedValuationUsd,
    impliedValuationBasis: impliedValuationUsd == null ? null : valuationExplanation,
    fieldSources: { ...row.fieldSources, impliedValuationUsd: valuationSource },
  };
}

async function hyperliquidRows(fetchImpl) {
  const [categories, allMeta] = await Promise.all([
    json(fetchImpl, hlEndpoint, { type: 'perpCategories' }),
    json(fetchImpl, hlEndpoint, { type: 'allPerpMetas' }),
  ]);
  if (!Array.isArray(categories) || !Array.isArray(allMeta)) throw new Error('Hyperliquid 未提供有效的合约分类和目录。');
  const byId = new Map(categories.filter((row) => Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string').map(([name, category]) => [name, category.toLowerCase()]));
  const eligible = (market) => typeof market?.name === 'string' && /^[\da-z]+:[\w.\-]+$/i.test(market.name) && !market.isDelisted && hlCategories.has(byId.get(market.name));
  const catalog = new Set(allMeta.flatMap((entry) => (Array.isArray(entry?.universe) ? entry.universe : []).filter(eligible).map((market) => market.name)));
  const dexes = [...new Set([...catalog].map((name) => name.split(':')[0]))];
  const rows = [];
  const failures = [];
  await Promise.all(dexes.map(async (dex) => {
    try {
      const body = await json(fetchImpl, hlEndpoint, { type: 'metaAndAssetCtxs', dex });
      if (!Array.isArray(body?.[0]?.universe) || !Array.isArray(body[1]) || body[0].universe.length !== body[1].length) throw new Error('行情与合约列表无法一一对应');
      const retrievedAt = timestamp();
      for (const [index, market] of body[0].universe.entries()) {
        if (!eligible(market) || !market.name.startsWith(`${dex}:`)) continue;
        const ctx = body[1][index] || {};
        const markPrice = number(ctx.markPx, { positive: true });
        const oraclePrice = number(ctx.oraclePx, { positive: true });
        const prior = number(ctx.prevDayPx, { positive: true });
        const changePct24h = prior == null || markPrice == null ? null : multiply(markPrice / prior - 1, 100);
        const volumeUsd = number(ctx.dayNtlVlm, { nonnegative: true });
        const openInterest = number(ctx.openInterest, { nonnegative: true });
        const openInterestUsd = multiply(markPrice, openInterest);
        const fundingRatePct = multiply(number(ctx.funding), 100);
        const symbol = market.name.split(':')[1];
        const category = hlCategories.get(byId.get(market.name));
        const raw = {
          name: market.name, category: byId.get(market.name), isDelisted: Boolean(market.isDelisted),
          markPx: ctx.markPx, oraclePx: ctx.oraclePx, prevDayPx: ctx.prevDayPx, dayNtlVlm: ctx.dayNtlVlm,
          openInterest: ctx.openInterest, funding: ctx.funding, collateralToken: body[0].collateralToken,
        };
        rows.push(assemble({
          id: `hyperliquid:${market.name}`, venue: 'hyperliquid', dex, symbol, marketId: market.name, label: symbol, category,
          status: 'trading', quoteCurrency: 'USD', notionalCurrency: 'USD', observedAt: null, retrievedAt,
          markPrice, oraclePrice, changePct24h, volumeUsd, openInterest, openInterestUsd, fundingRatePct,
          source: hgSource('按 perpCategories 认定类型，合并合约元数据和 metaAndAssetCtxs 行情。', 'measured', raw), raw,
          fieldSources: {
            markPrice: field(markPrice, hgSource('读取合约 markPx，单位为该永续的美元报价。', 'measured', { markPx: ctx.markPx })),
            oraclePrice: field(oraclePrice, hgSource('读取合约 oraclePx。对于预上市及休市时段，可能是合约内部参考价。', 'measured', { oraclePx: ctx.oraclePx })),
            changePct24h: field(changePct24h, hgSource('按 (markPx ÷ prevDayPx − 1) × 100 计算期间标记价变动百分比。', 'measured', { markPx: ctx.markPx, prevDayPx: ctx.prevDayPx })),
            volumeUsd: field(volumeUsd, hgSource('读取 dayNtlVlm（24 小时名义成交额）。', 'measured', { dayNtlVlm: ctx.dayNtlVlm })),
            openInterest: field(openInterest, hgSource('读取 openInterest（合约基础单位数量）。', 'measured', { openInterest: ctx.openInterest })),
            openInterestUsd: field(openInterestUsd, hgSource('openInterest × markPx，以美元计价估算当前名义持仓。', 'estimated', { openInterest: ctx.openInterest, markPx: ctx.markPx })),
            fundingRatePct: field(fundingRatePct, hgSource('读取 funding × 100，显示为每期百分比。', 'measured', { funding: ctx.funding })),
          },
        }));
      }
    } catch (error) { failures.push(`${dex}：${error.message}`); }
  }));
  if (!rows.length && failures.length) throw new Error(failures.join('；'));
  if (rows.length < catalog.size && !failures.length) failures.push('Hyperliquid 合约目录与当前行情数量不同，部分新上市或停交易合约暂缺。');
  return { rows, failures, totalMarkets: catalog.size };
}

function binanceCategory(info) {
  if (info?.contractType !== 'TRADIFI_PERPETUAL' || info.status !== 'TRADING' || info.quoteAsset !== 'USDT' || !/^[A-Z0-9]+USDT$/.test(info.symbol ?? '')) return null;
  if (info.underlyingType === 'PREMARKET' && info.underlyingSubType?.includes('Pre-IPO')) return 'pre-ipo';
  return bnCategories.get(info.underlyingType) ?? null;
}

async function binanceRows(fetchImpl, binanceOiLimit) {
  const batch = await Promise.allSettled(['exchangeInfo', 'ticker/24hr', 'premiumIndex'].map((path) => json(fetchImpl, bnEndpoint + path)));
  const [catalog, ticker, premium] = batch.map((item) => item.status === 'fulfilled' ? item.value : null);
  if (!Array.isArray(catalog?.symbols)) throw new Error('Binance 未提供有效的合约目录。');
  const failures = [];
  if (!Array.isArray(ticker)) failures.push('Binance 24 小时行情暂不可用。');
  if (!Array.isArray(premium)) failures.push('Binance 标记价及资金费率暂不可用。');
  const tickerBySymbol = new Map((Array.isArray(ticker) ? ticker : []).filter(Boolean).map((item) => [item.symbol, item]));
  const premiumBySymbol = new Map((Array.isArray(premium) ? premium : []).filter(Boolean).map((item) => [item.symbol, item]));
  const eligible = catalog.symbols.map((info) => ({ info, category: binanceCategory(info) })).filter((item) => item.category != null);
  eligible.sort((a, b) => Number(b.category === 'pre-ipo') - Number(a.category === 'pre-ipo')
    || (number(tickerBySymbol.get(b.info.symbol)?.quoteVolume) ?? -1) - (number(tickerBySymbol.get(a.info.symbol)?.quoteVolume) ?? -1)
    || a.info.symbol.localeCompare(b.info.symbol));
  const oiTarget = eligible.slice(0, binanceOiLimit);
  const oi = new Map();
  const oiFailures = [];
  const ratioTarget = eligible.filter((item) => item.category === 'pre-ipo').slice(0, 4);
  const ratioRequests = Promise.allSettled(ratioTarget.map(async ({ info: { symbol } }) => {
    const response = await json(fetchImpl, ratioUrl(symbol));
    const record = Array.isArray(response) ? response[0] : null;
    if (record?.symbol !== symbol || number(record.longShortRatio, { nonnegative: true }) == null || !asIso(record.timestamp)) throw new Error('缺少有效的账户多空比。');
    return [symbol, record];
  }));
  // Explicit bounded fan-out, no account authentication and no endpoint multiplication per table row.
  for (let i = 0; i < oiTarget.length; i += 6) {
    await Promise.all(oiTarget.slice(i, i + 6).map(async ({ info: { symbol } }) => {
      try {
        const row = await json(fetchImpl, `${bnEndpoint}openInterest?symbol=${encodeURIComponent(symbol)}`);
        if (row?.symbol !== symbol || number(row.openInterest, { nonnegative: true }) == null) throw new Error('缺少有效的未平仓量');
        oi.set(symbol, row);
      } catch { oiFailures.push(symbol); }
    }));
  }
  if (oiFailures.length) failures.push(`以下 Binance 合约的持仓量读取失败：${oiFailures.sort().join('、')}`);
  if (oiTarget.length < eligible.length) failures.push(`Binance 逐合约持仓量已优先查询 ${oiTarget.length} 项，其余暂缺。`);
  const ratios = await ratioRequests;
  const ratioBySymbol = new Map(ratios.filter((item) => item.status === 'fulfilled').map((item) => item.value));
  if (ratios.some((item) => item.status === 'rejected')) failures.push('部分 Binance 预上市合约缺少官方全体账户多空比。');
  const rows = eligible.map(({ info, category }) => {
    const { symbol } = info;
    const tick = tickerBySymbol.get(symbol) || {};
    const rates = premiumBySymbol.get(symbol) || {};
    const observedOi = oi.get(symbol);
    const observedRatio = ratioBySymbol.get(symbol);
    const markPrice = number(rates.markPrice, { positive: true });
    const oraclePrice = category === 'pre-ipo' ? null : number(rates.indexPrice, { positive: true });
    const changePct24h = number(tick.priceChangePercent);
    const volumeUsd = number(tick.quoteVolume, { nonnegative: true });
    const openInterest = number(observedOi?.openInterest, { nonnegative: true });
    const openInterestUsd = multiply(markPrice, openInterest);
    const fundingRatePct = multiply(number(rates.lastFundingRate), 100);
    const raw = {
      symbol, underlyingType: info.underlyingType, underlyingSubType: info.underlyingSubType,
      status: info.status, contractType: info.contractType, quoteAsset: info.quoteAsset, priceChangePercent: tick.priceChangePercent,
      quoteVolume: tick.quoteVolume, closeTime: tick.closeTime, markPrice: rates.markPrice, indexPrice: rates.indexPrice,
      lastFundingRate: rates.lastFundingRate, nextFundingTime: rates.nextFundingTime, priceTime: rates.time,
      openInterest: observedOi?.openInterest, openInterestTime: observedOi?.time,
      longShortRatio: observedRatio?.longShortRatio, longAccount: observedRatio?.longAccount,
      shortAccount: observedRatio?.shortAccount, ratioTimestamp: observedRatio?.timestamp,
    };
    const longRatio = number(observedRatio?.longShortRatio, { nonnegative: true });
    return assemble({
      id: `binance:${symbol}`, venue: 'binance', dex: null, symbol, marketId: symbol, label: info.baseAsset || symbol, category,
      status: 'trading', quoteCurrency: 'USDT', notionalCurrency: 'USDT', observedAt: asIso(rates.time) || asIso(tick.closeTime), retrievedAt: timestamp(),
      markPrice, oraclePrice, changePct24h, volumeUsd, openInterest, openInterestUsd, fundingRatePct,
      ...(category === 'pre-ipo' ? { longRatio, longRatioAt: asIso(observedRatio?.timestamp), longRatioPeriod: '5m' } : {}),
      source: sourceForBinance('info', symbol, '读取交易所实时合约类型、标的类型和交易状态。', 'measured', raw), raw,
      fieldSources: {
        markPrice: field(markPrice, sourceForBinance('mark', symbol, '读取 markPrice，单位 USDT。', 'measured', { markPrice: rates.markPrice, time: rates.time })),
        oraclePrice: category === 'pre-ipo'
          ? source('Binance 预上市定价说明', binancePreIpo, binancePreIpo, '公开 API 的 indexPrice 字段不表明预上市合约拥有可独立验证的现货参考价，此处留空。', 'missing', { indexPrice: rates.indexPrice })
          : field(oraclePrice, sourceForBinance('mark', symbol, '读取合约 indexPrice，单位 USDT。', 'measured', { indexPrice: rates.indexPrice, time: rates.time })),
        changePct24h: field(changePct24h, sourceForBinance('ticker', symbol, '读取 24 小时滚动成交价变动百分比 priceChangePercent。', 'measured', { priceChangePercent: tick.priceChangePercent, closeTime: tick.closeTime })),
        volumeUsd: field(volumeUsd, sourceForBinance('ticker', symbol, '读取 24 小时报价币成交额 quoteVolume，原单位 USDT，未换算成法币。', 'measured', { quoteVolume: tick.quoteVolume, closeTime: tick.closeTime })),
        openInterest: field(openInterest, sourceForBinance('oi', symbol, '读取 openInterest（合约基础单位数量）。', 'measured', { openInterest: observedOi?.openInterest, time: observedOi?.time }), '此合约未取得官方未平仓量。'),
        openInterestUsd: field(openInterestUsd, sourceForBinance('oi', symbol, 'openInterest × premiumIndex 的 markPrice，名义值单位 USDT。', 'estimated', { openInterest: observedOi?.openInterest, openInterestTime: observedOi?.time, markPrice: rates.markPrice, priceTime: rates.time }), '缺少可用于合约名义值计算的未平仓量或标记价。'),
        fundingRatePct: field(fundingRatePct, sourceForBinance('mark', symbol, '读取 lastFundingRate × 100，显示为每期百分比。', 'measured', { lastFundingRate: rates.lastFundingRate, nextFundingTime: rates.nextFundingTime })),
        ...(category === 'pre-ipo' ? { longRatio: field(longRatio, source('Binance 全体账户多空比', ratioUrl(symbol), `${bnDocs}Long-Short-Ratio`, '最新 5 分钟净多账户数 ÷ 净空账户数，按账户计数。', 'measured', observedRatio), '没有查询到该预上市合约的官方全体账户多空比。') } : {}),
      },
    });
  });
  return { rows, failures, totalMarkets: eligible.length };
}

/** Read the current catalog of active synthetic TradFi contracts from official public feeds. */
export async function loadTradfi({ venue = 'multi', fetchImpl = globalThis.fetch, binanceOiLimit = 12 } = {}) {
  if (!Number.isInteger(binanceOiLimit) || binanceOiLimit < 0 || binanceOiLimit > 24) throw new RangeError('Binance 持仓采样上限需为 0–24 个合约。');
  if (!['multi', 'all', 'hyperliquid', 'binance'].includes(venue)) throw new RangeError('TradFi 行情仅支持 Binance 与 Hyperliquid。');
  const venues = ['multi', 'all'].includes(venue) ? ['hyperliquid', 'binance'] : [venue];
  const results = await Promise.allSettled(venues.map((id) => id === 'hyperliquid' ? hyperliquidRows(fetchImpl) : binanceRows(fetchImpl, binanceOiLimit)));
  const rows = results.flatMap((result) => result.status === 'fulfilled' ? result.value.rows : []);
  rows.sort((a, b) => Number(b.category === 'pre-ipo') - Number(a.category === 'pre-ipo') || (b.volumeUsd ?? -1) - (a.volumeUsd ?? -1) || a.id.localeCompare(b.id));
  const venueCoverage = results.map((result, index) => {
    const venue = venues[index];
    const link = venue === 'hyperliquid' ? hlDocs : `${bnDocs}Exchange-Information`;
    if (result.status === 'rejected') return { venue, status: 'missing', reason: result.reason?.message || '此交易所暂不可用。', rows: 0, link };
    const { rows: venueRows, failures, totalMarkets } = result.value;
    const missingFields = Object.fromEntries(metricKeys.map((key) => [key, venueRows.filter((row) => row[key] == null).length]));
    return { venue, status: failures.length ? 'partial' : 'available', reason: failures.join('；') || null, rows: venueRows.length, totalMarkets, missingFields, link };
  });
  const status = venueCoverage.every((item) => item.status === 'available') ? 'available'
    : venueCoverage.every((item) => item.status === 'missing') ? 'missing' : 'partial';
  return {
    venue: venues.length === 1 ? venues[0] : 'multi', loadedAt: timestamp(), rows,
    coverage: {
      status,
      reason: venueCoverage.map((item) => item.reason).filter(Boolean).join('；') || null,
      venues: venueCoverage,
      notes: [
        '仅展示官方合约目录中已分类、可交易的合成永续合约。现货股票价格、持股权益和发行估值须以对应市场资料为准。',
        'Hyperliquid 采用美元名义报价；Binance 采用 USDT 名义报价；未做汇率换算。两家 24 小时涨跌分别依据标记价和滚动成交价。',
        '预上市合约以当前交易所分类为准。市值仅在报价与可核对口径匹配时估算；不同合约报价基准可能不同。',
      ],
    },
  };
}
