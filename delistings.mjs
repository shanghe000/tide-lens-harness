import { createHash } from 'node:crypto';

const day = 86_400_000;
const venues = ['binance', 'okx', 'bybit'];
const noticePageLimit = 20;
const binanceDetails = 'https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query';
const binanceIndex = 'https://www.binance.com/en/support/announcement/list/00000000000000000000000000161/';
const binanceArticle = 'https://www.binance.com/en/support/announcement/detail/';
const spotSources = {
  okx: {
    label: 'OKX 现货产品信息',
    url: 'https://openapi.okx.com/api/v5/public/instruments?instType=SPOT',
    docs: 'https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments',
    method: '使用公开现货产品的 expTime，仅覆盖该访问地区仍在产品列表中的交易对。',
    marketTypes: ['spot'],
  },
};
const instrumentSources = {
  binance: {
    label: 'Binance USDⓈ-M 永续合约信息',
    url: 'https://fapi.binance.com/fapi/v1/exchangeInfo',
    docs: 'https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data#exchange-information',
    method: '只记录 USDT 永续的有效 deliveryDate。排除常驻占位日期和交割合约。仅覆盖当前接口返回的合约。',
    marketTypes: ['perpetual'],
  },
  okx: {
    label: 'OKX USDT 永续合约信息',
    url: 'https://openapi.okx.com/api/v5/public/instruments?instType=SWAP',
    docs: 'https://www.okx.com/docs-v5/en/#public-data-rest-api-get-instruments',
    method: '只读取公开 USDT 永续合约的 expTime。接口只覆盖该访问地区可见、仍在产品列表中的合约。',
    marketTypes: ['perpetual'],
  },
  bybit: {
    label: 'Bybit USDT 永续合约信息',
    url: 'https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000',
    docs: 'https://bybit-exchange.github.io/docs/v5/market/instrument',
    method: '公开 linear 产品列表，最多读取两页。只记录 USDT 永续的非零 deliveryTime，排除普通交割合约。',
    marketTypes: ['perpetual'],
  },
};
const noticeSources = {
  binance: {
    label: 'Binance 官方下架公告',
    url: 'https://www.binance.com/bapi/composite/v1/public/cms/article/catalog/list/query?catalogId=161&pageNo=1&pageSize=20',
    docs: binanceIndex,
    method: '读取官网下架栏目最新 20 条目录，并核对现货/永续公告正文。官网页面数据接口没有公开 API 稳定性承诺。',
    marketTypes: ['spot', 'perpetual'],
  },
  okx: {
    label: 'OKX 官方下架公告',
    url: 'https://openapi.okx.com/api/v5/support/announcements?annType=announcements-delistings&page=1',
    docs: 'https://www.okx.com/docs-v5/en/#announcement-get-announcements',
    method: '读取按访问 IP 筛选的公告首屏，最多 20 条。pTime 是公告发布时间；没有结构化生效时间时需核对原文。',
    marketTypes: ['spot', 'perpetual', 'other'],
  },
  bybit: {
    label: 'Bybit 官方下架公告',
    url: 'https://api.bybit.com/v5/announcements/index?locale=en-US&type=delistings&limit=20&page=1',
    docs: 'https://bybit-exchange.github.io/docs/v5/announcement',
    method: '读取全类别下架公告首屏，最多 20 条。仅从明确下架句中的完整 UTC 日期时间提取时间，publishTime 是发布时间。',
    marketTypes: ['spot', 'perpetual', 'other'],
  },
};

function epoch(value) {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return Number.isSafeInteger(number) && number > 0 && number < 8_640_000_000_000_000 ? number : null;
}

function utcDate(year, month, date, hour, minute) {
  if (!(year >= 2000 && month >= 0 && month < 12 && date > 0 && hour >= 0 && hour < 24 && minute >= 0 && minute < 60)) return null;
  const value = new Date(Date.UTC(year, month, date, hour, minute));
  return value.getUTCMonth() === month && value.getUTCDate() === date ? value.getTime() : null;
}

function timeMentions(text) {
  const values = [];
  for (const match of text.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)[ T]+(\d\d?):(\d\d)\s*\(?UTC\b\)?/giu)) {
    values.push({ text: match[0], timestamp: utcDate(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]) });
  }
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  for (const match of text.matchAll(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),?\s+(20\d{2}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\s*\(?UTC\b\)?/giu)) {
    let hour = +match[4];
    if (match[6]) {
      if (hour < 1 || hour > 12) continue;
      hour = hour % 12 + (match[6].toUpperCase() === 'PM' ? 12 : 0);
    }
    const month = months.findIndex(item => item.toLowerCase() === match[1].slice(0, 3).toLowerCase());
    values.push({ text: match[0], timestamp: utcDate(+match[3], month, +match[2], hour, +match[5]) });
  }
  return values.filter(value => value.timestamp !== null);
}

function singleTime(text) {
  const values = timeMentions(text);
  return new Set(values.map(value => value.timestamp)).size === 1 ? values[0] : null;
}

function marketType(title, tags = []) {
  if (/\b(?:perpetual|perpetuals|perps?)\b/i.test(title)) return 'perpetual';
  if (/\bspot\b/i.test(title) || tags.includes('Spot')) return 'spot';
  if (/\b(?:margin|collateral|loan|lending|convert|alpha|options?)\b/i.test(title)) return 'other';
  if (/\b(?:futures|contract|contracts)\b/i.test(title) || tags.includes('Derivatives')) return 'derivatives';
  return 'unknown';
}

function contractSymbols(text, market) {
  const pattern = market === 'spot' ? /\b[A-Z0-9]{1,24}\s*(?:\/|-)\s*(?:USDT|USDC|FDUSD|BTC|ETH|BNB|EUR)\b/g
    : /\b[A-Z0-9]{1,24}(?:-USDT-SWAP|(?:USDT|USDC)(?:-PERP)?)\b/g;
  return [...new Set((text.match(pattern) ?? []).map(symbol => symbol.replace(/\s/gu, '')))].slice(0, 40);
}

function publicLink(raw, host) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && url.host === host && !url.username && !url.password) {
      return url.origin + url.pathname + url.search + url.hash;
    }
  } catch {}
  return null;
}

function makeRow(entry, observedAt, recentSince) {
  const { effectiveAt = null, publishedAt = null, symbols = [], url = null } = entry;
  if (publishedAt !== null && publishedAt > observedAt) return null;
  if (effectiveAt !== null && effectiveAt < recentSince && !(publishedAt >= recentSince)) return null;
  if (effectiveAt === null && (publishedAt === null || publishedAt < recentSince) && !entry.keepUnknownTime) return null;
  const stage = effectiveAt === null ? 'notice' : effectiveAt > observedAt ? 'upcoming' : 'recent';
  const id = createHash('sha256').update(JSON.stringify([entry.venue, entry.marketType, url, symbols, effectiveAt])).digest('hex');
  const { keepUnknownTime: _, ...record } = entry;
  return { ...record, id, observedAt, effectiveAt, publishedAt, symbols, symbol: symbols.length === 1 ? symbols[0] : null, stage, url };
}

async function json(fetchImpl, url) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(7_500), redirect: 'error',
    headers: { accept: 'application/json', 'accept-language': 'en-US' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function requireRows(rows) {
  if (!Array.isArray(rows)) throw new Error('响应缺少预期的公开记录。');
  return rows;
}

function withQuality(source) {
  return { ...source, quality: 'measured' };
}

function perpetual(venue, row, source) {
  const fields = {
    binance: ['symbol', 'deliveryDate', 'contractType', 'PERPETUAL', 'quoteAsset', 'baseAsset', 'status'],
    okx: ['instId', 'expTime', 'instType', 'SWAP', 'settleCcy', 'baseCcy', 'state'],
    bybit: ['symbol', 'deliveryTime', 'contractType', 'LinearPerpetual', 'quoteCoin', 'baseCoin', 'status'],
  };
  const [symbolKey, timeKey, kindKey, kind, quoteKey, baseKey, statusKey] = fields[venue];
  if (row?.[kindKey] !== kind || row[quoteKey] !== 'USDT' ||
      typeof row[symbolKey] !== 'string' || !/^[A-Z0-9-]{3,30}$/u.test(row[symbolKey])) return null;
  const effectiveAt = epoch(row[timeKey]);
  if (!effectiveAt || (venue === 'binance' && effectiveAt === 4_133_404_800_000)) return null;
  const symbols = [row[symbolKey]];
  return {
    venue, marketType: 'perpetual', kind: 'schedule', title: symbols[0] + ' 永续下架时间',
    symbols, effectiveAt, source: withQuality(source), url: source.url,
    raw: Object.fromEntries([symbolKey, timeKey, kindKey, quoteKey, baseKey, statusKey].map(key => [key, row[key] ?? null])),
  };
}

async function instruments(venue, fetchImpl) {
  const source = instrumentSources[venue];
  let payload = await json(fetchImpl, source.url);
  let rows;
  let limited = false;
  let diagnostic = null;
  if (venue === 'binance') rows = requireRows(payload?.symbols);
  if (venue === 'okx') rows = requireRows(payload?.code === '0' ? payload.data : null);
  if (venue === 'bybit') {
    rows = requireRows(payload?.retCode === 0 ? payload.result?.list : null);
    if (payload.result.nextPageCursor) {
      try {
        const next = new URL(source.url);
        next.searchParams.set('cursor', payload.result.nextPageCursor);
        payload = await json(fetchImpl, next.href);
        rows = rows.concat(requireRows(payload?.retCode === 0 ? payload.result?.list : null));
        limited = Boolean(payload.result.nextPageCursor);
      } catch {
        limited = true;
        diagnostic = 'Bybit 产品列表后续页暂不可用。';
      }
    }
  }
  return { rows: rows.map(row => perpetual(venue, row, source)).filter(Boolean), scanned: rows.length, limited, diagnostic };
}

async function spotInstruments(venue, fetchImpl) {
  const source = spotSources[venue];
  const payload = await json(fetchImpl, source.url);
  const rows = requireRows(payload?.code === '0' ? payload.data : null);
  return { scanned: rows.length, rows: rows.flatMap(row => {
    const effectiveAt = epoch(row?.expTime);
    if (row?.instType !== 'SPOT' || !/^[A-Z0-9]{1,24}-[A-Z0-9]{2,12}$/u.test(row?.instId ?? '') || !effectiveAt) return [];
    return [{
      venue, marketType: 'spot', kind: 'schedule', symbols: [row.instId], effectiveAt,
      title: row.instId + ' 现货下架时间', source: withQuality(source), url: source.url,
      raw: { instId: row.instId, instType: row.instType, expTime: row.expTime, state: row.state ?? null },
    }];
  }) };
}

function normalizeAnnouncement(venue, row) {
  const bybit = venue === 'bybit';
  const url = publicLink(row?.url, bybit ? 'announcements.bybit.com' : 'www.okx.com');
  const title = typeof row?.title === 'string' ? row.title.trim() : '';
  const publishedAt = epoch(bybit ? row?.publishTime : row?.pTime);
  const kind = bybit ? row?.type?.key : row?.annType;
  if (!url || !title || !publishedAt || kind !== (bybit ? 'delistings' : 'announcements-delistings')) return null;
  const tags = Array.isArray(row.tags) ? row.tags.filter(tag => typeof tag === 'string').slice(0, 25) : [];
  const market = marketType(title + (bybit && typeof row.description === 'string' ? ' ' + row.description : ''), tags);
  const direct = bybit && /\b(?:will be delisting|will delist|will remove|will cease trading)\b/i.test(row.description ?? '')
    && /\b(?:perpetual|spot trading pair|contract)\b/i.test(title)
    && !/\b(?:postpone|cancel|reschedul|previously|originally)\w*\b/i.test(title + ' ' + row.description)
    ? singleTime(row.description) : null;
  const symbols = [...new Set([...contractSymbols(title, market),
    ...(market === 'spot' && bybit ? contractSymbols(row.description ?? '', market) : [])])];
  return {
    venue, marketType: market, kind: 'announcement', title, publishedAt, effectiveAt: direct?.timestamp ?? null,
    symbols, url, source: withQuality(noticeSources[venue]),
    raw: {
      title, type: kind, tags,
      ...(bybit ? { publishTime: row.publishTime, dateTimestamp: row.dateTimestamp ?? null }
        : { pTime: row.pTime, businessPTime: row.businessPTime ?? null }),
      utcText: direct?.text ?? null,
    },
  };
}

async function standardNotices(venue, fetchImpl) {
  const payload = await json(fetchImpl, noticeSources[venue].url);
  const bybit = venue === 'bybit';
  const rows = requireRows(bybit ? payload?.retCode === 0 && payload.result?.list
    : payload?.code === '0' && payload.data?.[0]?.details);
  const entries = rows.map(row => normalizeAnnouncement(venue, row)).filter(Boolean);
  const limited = bybit ? Number(payload.result.total) > rows.length : Number(payload.data[0].totalPage) > 1;
  return { rows: entries, scanned: rows.length, limited };
}

function articleBlocks(body) {
  try {
    const root = JSON.parse(body);
    const flat = (node, depth = 0) => depth <= 20 && node
      ? typeof node.text === 'string' ? node.text : Array.isArray(node.child)
        ? node.child.slice(0, 300).map(child => flat(child, depth + 1)).join('') : ''
      : '';
    return requireRows(root.child).slice(0, 90).flatMap(node => {
      const group = ['ul', 'ol'].includes(node.tag) && Array.isArray(node.child) ? node.child.slice(0, 80) : [node];
      return group.map(child => flat(child).replace(/(?:&nbsp;|\s)+/gu, ' ').trim()).filter(Boolean);
    });
  } catch {
    return [];
  }
}

function isDelistingTitle(title) {
  return /\b(?:delist(?:ing|ed|s)?|removal|remove(?:d|s)?)\b/iu.test(title)
    && !/\b(?:temporar\w*|suspend\w*|suspension|resum\w*|maintenance)\b/iu.test(title);
}

function binanceEvents(article, title, market) {
  const blocks = articleBlocks(article?.body);
  const events = [];
  for (const [index, block] of blocks.entries()) {
    if (/^(?:Please Note:|For More Information:)/iu.test(block) && !events.length) break;
    const previous = blocks[index - 1] ?? '';
    const derivative = /\b(?:perpetual contracts?|automatic settlement|close all positions)\b/iu;
    const spot = /\b(?:spot trading pairs?|cease trading)\b/iu;
    const schedule = market === 'spot'
      ? spot.test(block) || (spot.test(previous) && /^(?:At |\d{4}-)/u.test(block))
      : derivative.test(block) || (derivative.test(previous) && /^(?:At |\d{4}-)/u.test(block));
    if (!schedule || /\b(?:trading bots?|copy trading|no longer submit|allowed to open|not allowed|funding rate|insurance fund|previously|originally|cancel|postpone|temporar\w*|suspend\w*|suspension|resum\w*)\b/iu.test(block)) continue;
    const utc = singleTime(block);
    if (!utc) continue;
    let symbols = contractSymbols(block, market);
    if (!symbols.length && market === 'perpetual') symbols = contractSymbols(title, market);
    if (!symbols.length && market === 'spot' && /following tokens?\(s\)/iu.test(block)) {
      const next = blocks.slice(index + 1, index + 12);
      for (const candidate of next) {
        const token = /\(([A-Z0-9]{2,15})\)$/u.exec(candidate);
        if (!token) break;
        symbols.push(token[1]);
      }
    }
    if (symbols.length) events.push({ symbols, ...utc });
  }
  return events;
}

async function binanceNotices(fetchImpl, recentSince) {
  const payload = await json(fetchImpl, noticeSources.binance.url);
  const listed = requireRows(payload?.code === '000000' ? payload.data?.articles : null).slice(0, noticePageLimit);
  const picked = listed.filter(row => /^[a-f0-9]{32}$/iu.test(row?.code ?? '') &&
    isDelistingTitle(row.title ?? '') &&
    (/spot trading pairs?|perpetual/iu.test(row.title ?? '') || /^Binance Will Delist\b/iu.test(row.title ?? '')));
  const rows = [];
  let detailFailures = 0;
  for (let start = 0; start < picked.length; start += 4) {
    await Promise.all(picked.slice(start, start + 4).map(async item => {
      let article;
      try {
        const detailed = await json(fetchImpl, binanceDetails + '?articleCode=' + item.code);
        if (detailed?.code !== '000000' || detailed.data?.code !== item.code) throw new Error();
        article = detailed.data;
      } catch { detailFailures++; }

      const title = (article?.title || item.title).trim();
      if (!isDelistingTitle(title)) return;
      let market = marketType(title);
      if (market === 'unknown' && /^Binance Will Delist\b/iu.test(title)) market = 'spot';
      const publishedAt = epoch(article?.publishDate ?? item.publishDate);
      const url = binanceArticle + item.code;
      const source = withQuality({ ...noticeSources.binance, url });
      const events = /\b(?:postpone|cancel|reschedul|updated notice)\w*\b/iu.test(title)
        ? [] : binanceEvents(article, title, market);
      const base = { venue: 'binance', marketType: market, kind: 'announcement', title, publishedAt, url, source };
      const raw = { articleCode: item.code, title, publishDate: article?.publishDate ?? item.publishDate ?? null };
      if (!events.length) {
        if (publishedAt === null) {
          const titleDates = [...title.matchAll(/\b(20\d\d)-(\d\d)-(\d\d)\b/gu)]
            .map(match => utcDate(+match[1], +match[2] - 1, +match[3], 0, 0));
          if (!titleDates.some(value => value >= recentSince - day)) return;
        }
        rows.push({ ...base, symbols: contractSymbols(title, market), raw, keepUnknownTime: publishedAt === null });
        return;
      }
      for (const event of events) rows.push({ ...base, symbols: event.symbols, effectiveAt: event.timestamp,
        raw: { ...raw, utcText: event.text } });
    }));
  }
  return { rows, scanned: listed.length, limited: Number(payload.data.total) > listed.length || detailFailures > 0,
    diagnostic: detailFailures ? `有 ${detailFailures} 篇公告详情暂不可用，未补造发布时间和生效时间。` : null };
}

function mergeRows(rows) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const stage = { upcoming: 0, recent: 1, notice: 2 };
  return [...byId.values()].sort((a, b) => stage[a.stage] - stage[b.stage] ||
    (a.stage === 'upcoming' ? a.effectiveAt - b.effectiveAt
      : (b.effectiveAt ?? b.publishedAt ?? 0) - (a.effectiveAt ?? a.publishedAt ?? 0)) || a.id.localeCompare(b.id));
}

export async function loadDelistings({ venue = 'all', window = '30d', fetchImpl = fetch, now = Date.now } = {}) {
  if (venue !== 'all' && !venues.includes(venue)) throw new RangeError('所选交易所无效。');
  const days = { '7d': 7, '30d': 30, '90d': 90 }[window];
  if (!Number.isInteger(days)) throw new RangeError('下架监控仅支持最近 7、30 或 90 天。');
  const asOf = typeof now === 'function' ? now() : now;
  if (epoch(asOf) !== asOf) throw new RangeError('观测时间无效。');
  const recentSince = asOf - days * day;
  const selectedVenues = venue === 'all' ? venues : [venue];
  const rows = [];
  const sources = Object.fromEntries(selectedVenues.map(item => [item, []]));
  const errors = {};
  await Promise.all(selectedVenues.map(async item => {
    const feeds = [
      [instrumentSources[item], 'schedule', () => instruments(item, fetchImpl)],
      [noticeSources[item], 'announcements', () => item === 'binance'
        ? binanceNotices(fetchImpl, recentSince) : standardNotices(item, fetchImpl)],
    ];
    if (spotSources[item]) feeds.push([spotSources[item], 'spot-schedule', () => spotInstruments(item, fetchImpl)]);
    const results = await Promise.allSettled(feeds.map(([, , request]) => request()));
    results.forEach((result, index) => {
      const [definition, kind] = feeds[index];
      if (result.status === 'rejected') {
        const detail = `暂无法读取公开来源${/^HTTP \d{3}$/u.test(result.reason?.message) ? '（' + result.reason.message + '）' : ''}。`;
        sources[item].push({ ...definition, kind, status: 'unavailable', quality: 'missing', scanned: null, count: null, detail });
        errors[item + ':' + kind] = detail;
        return;
      }
      const { scanned, limited, diagnostic } = result.value;
      const inWindow = result.value.rows.map(entry => makeRow(entry, asOf, recentSince)).filter(Boolean);
      rows.push(...inWindow);
      sources[item].push({
        ...definition, kind, quality: 'measured', scanned, count: inWindow.length,
        status: diagnostic ? 'partial' : inWindow.length ? 'available' : 'empty',
        limited: Boolean(limited), detail: diagnostic ?? null,
      });
      if (diagnostic) errors[item + ':' + kind] = diagnostic;
    });
  }));
  return { asOf, window, timezone: 'UTC', recentSince, rows: mergeRows(rows), sources, errors };
}
