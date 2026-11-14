import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadMarket, loadReplayTick, loadScreener } from './market.mjs';
import { projectLiquidations } from './models.mjs';
import { createReviews, factForMarket, makeFact } from './reviews.mjs';
import { calculate, loadWhale } from './advanced.mjs';
import { normalizeDrawings } from './ui/drawings.js';
import { createReplay } from './replay.mjs';
import { loadWhaleHistory } from './whale-history.mjs';
import { loadTradfi } from './tradfi.mjs';
import { loadDelistings } from './delistings.mjs';

const ui = fileURLToPath(new URL('./ui/', import.meta.url));
const staticFiles = new Map([
  ['', ['index.html', 'text/html; charset=utf-8']],
  ['market-watch.js', ['market-watch.js', 'text/javascript; charset=utf-8']],
  ['drawings.js', ['drawings.js', 'text/javascript; charset=utf-8']],
  ['app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['advanced.mjs', ['../advanced.mjs', 'text/javascript; charset=utf-8']],
]);
const metricKeys = ['price','change','oi','oiUsd','funding','longRatio'];

async function readBody(request, limit=24_576) {
  let length = 0;
  const buffers = [];
  for await (const buffer of request) {
    length += buffer.length;
    if (length > limit) throw new Error('请求内容过长。');
    buffers.push(buffer);
  }
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
}

function cacheReads(ttl, limit, read) {
  const cache = new Map();
  return (key, input) => {
    const entry = cache.get(key);
    if (entry && entry.expires > Date.now()) return entry.result;
    const result = Promise.resolve().then(() => read(input)).catch(error => {
      if (cache.get(key)?.result === result) cache.delete(key);
      throw error;
    });
    cache.set(key, { result, expires: Date.now() + ttl });
    if (cache.size > limit) cache.delete(cache.keys().next().value);
    return result;
  };
}

export async function startDashboard({
  dataDirectory = process.env.TIDE_LENS_REVIEW_DIR || join(homedir(), '.tide-lens', 'reviews'),
  marketLoader = loadMarket,
  screenerLoader = loadScreener,
  whaleLoader = loadWhale,
  whaleHistoryLoader = loadWhaleHistory,
  replayMarketLoader = loadReplayTick,
  tradfiLoader = loadTradfi,
  delistingsLoader = loadDelistings,
} = {}) {
  const reviews = createReviews(dataDirectory);
  const recorder = createReplay({dataDirectory,marketLoader:replayMarketLoader});
  const preferencesFile = join(dataDirectory, 'preferences.json');
  let preferencesQueue = Promise.resolve();
  const initial = { watchlist: [], rules: [], events: [], drawings: {} };
  async function preferences() {
    try { return {...initial, ...JSON.parse(await readFile(preferencesFile, 'utf8'))}; }
    catch (error) {
      if (error.code === 'ENOENT') return initial;
      throw error;
    }
  }
  function savePreferences(patch) {
    const updated = preferencesQueue.then(async () => {
      const current = await preferences();
      const fields = {watchlist:100,rules:100,events:50};
      for (const [key, limit] of Object.entries(fields)) {
        if (Array.isArray(patch[key])) current[key] = patch[key].slice(0,limit);
      }
      if (patch.drawing && typeof patch.drawing.key === 'string' && /^(okx|binance|bybit):[A-Z0-9]{1,20}$/.test(patch.drawing.key)) {
        const history = { ...current.drawings };
        delete history[patch.drawing.key];
        const items = normalizeDrawings(patch.drawing.items);
        if (items.length) history[patch.drawing.key] = items;
        current.drawings = Object.fromEntries(Object.entries(history).slice(-100));
      }
      await mkdir(dataDirectory,{recursive:true,mode:0o700});
      const temporary = preferencesFile + '.' + randomBytes(8).toString('hex');
      await writeFile(temporary,JSON.stringify(current),{encoding:'utf8',mode:0o600,flag:'wx'});
      await rename(temporary,preferencesFile);
      return current;
    });
    preferencesQueue = updated.catch(() => {});
    return updated;
  }
  const lookupMarket = cacheReads(15_000, 40, marketLoader);
  const lookupScreener = cacheReads(35_000, 5, screenerLoader);
  const lookupTradfi = cacheReads(60_000, 3, tradfiLoader);
  const lookupDelistings = cacheReads(75_000, 12, delistingsLoader);
  const facts = new Map();
  const snapshots = new Map();
  const prefix = '/' + randomBytes(24).toString('hex') + '/';
  let origin;

  function keepFact(fact) {
    if (!fact) return;
    facts.set(fact.id, fact);
    if (facts.size > 4000) facts.delete(facts.keys().next().value);
  }

  const reviewFields = {
    markPrice:['合约标记价','报价币'], oraclePrice:['参考价','报价币'],
    changePct24h:['合约 24 小时变动','%'], volumeUsd:['24 小时成交额','USD 等值'],
    openInterest:['未平仓量','基础单位'], openInterestUsd:['名义持仓','USD 等值'],
    fundingRatePct:['资金费率','%'], longRatio:['账户多空比','倍'], impliedValuationUsd:['隐含估值','USD 等值'],
  };
  const timestamp = value => typeof value === 'number' ? value : Date.parse(value);
  const validSource = source => source?.quality === 'measured' || source?.quality === 'estimated';

  const routes = {
    'GET api/tradfi': async ({searchParams}) => {
      const venue=searchParams.get('venue') || 'all';
      if (!['all','binance','hyperliquid'].includes(venue)) throw new RangeError('不支持该合约来源。');
      const result=await lookupTradfi(venue,{venue});
      const asOf=timestamp(result.loadedAt ?? result.asOf);
      const rows=result.rows.filter(row=>venue==='all'||row.venue?.toLowerCase()===venue).map(row=>{
        const audit={};
        if (!result.demo) for (const [key,[label,unit]] of Object.entries(reviewFields)) {
          const source=row.fieldSources?.[key];
          if (!validSource(source)) continue;
          const fieldTime=source.raw?.closeTime ?? source.raw?.time ?? source.raw?.timestamp ?? source.raw?.openInterestTime;
          const applicableUnit=key==='markPrice'||key==='oraclePrice'?row.quoteCurrency??unit:
            ['volumeUsd','openInterestUsd'].includes(key)?row.notionalCurrency??unit:unit;
          const fact=makeFact({key:`tradfi:${row.id}:${key}`,venue:row.venue.toLowerCase(),symbol:row.symbol,
            asOf:timestamp(row.fieldTimes?.[key] ?? fieldTime ?? row.observedAt ?? row.retrievedAt ?? row.asOf) || asOf,
            label,unit:applicableUnit,value:row[key],
            quality:source.quality,source,context:{contract:row.id,category:row.category,field:key,provider:row.dex ?? null,raw:source.raw ?? null,basis:key==='impliedValuationUsd'?row.impliedValuationBasis:null}});
          if(fact){keepFact(fact);audit[key]=fact;}
        }
        return {...row,audit};
      });
      return {...result,rows};
    },
    'GET api/delistings': async ({searchParams}) => {
      const venue=searchParams.get('venue') || 'all';
      const window=searchParams.get('window') || '30d';
      if(!['all','okx','binance','bybit'].includes(venue)||!['7d','30d','90d'].includes(window)) {
        throw new RangeError('不支持该交易所或时间范围。');
      }
      const result=await lookupDelistings(venue+':'+window,{venue,window});
      const rows=result.rows.map(row=>{
        const source=row.source;
        const effectiveAt=timestamp(row.effectiveAt);
        const fact=!result.demo&&validSource(source) ? makeFact({
          key:`delisting:${row.id}`,venue:row.venue,symbol:row.symbol ?? row.symbols?.join(', ') ?? '交易所公告',
          asOf:timestamp(row.publishedAt ?? row.observedAt ?? result.asOf),label:'公告生效时间',unit:'UTC 毫秒',
          value:effectiveAt,quality:source.quality,source,context:{stage:row.stage,marketType:row.marketType ?? row.market ?? null,
            effectiveAt:Number.isFinite(effectiveAt)?new Date(effectiveAt).toISOString():null,noticeTitle:row.title},
        }) : null;
        keepFact(fact);
        return {...row,fact};
      });
      return {...result,rows};
    },
    'GET api/market': async ({ searchParams }) => {
      const venue = searchParams.get('venue') || 'okx';
      const symbol = searchParams.get('symbol') || 'BTC';
      const window = searchParams.get('window') || '24h';
      const market = await lookupMarket([venue,symbol,window].join(':'), {venue,symbol,window});
      const model = projectLiquidations(market);
      const snapshot = { ...market, model };
      const keys = [...metricKeys, ...model.levels.slice(0,24).map(level => 'model:' + level.side + ':' + level.price)];
      const audit = market.demo ? {} : Object.fromEntries(keys.map(key => [key, factForMarket(snapshot, key)]).filter(([,v]) => v));
      Object.values(audit).forEach(keepFact);
      const snapshotId = randomBytes(12).toString('hex');
      snapshots.set(snapshotId, snapshot);
      if (snapshots.size > 40) snapshots.delete(snapshots.keys().next().value);
      return { ...snapshot, snapshotId, audit };
    },
    'GET api/fact': ({ searchParams }) => {
      const snapshot = snapshots.get(searchParams.get('snapshot'));
      if (!snapshot) throw new Error('快照已过期，请刷新。');
      const fact = snapshot.demo ? null : factForMarket(snapshot, searchParams.get('key'));
      keepFact(fact);
      return { fact };
    },
    'GET api/screener': ({ searchParams }) => {
      const venue = searchParams.get('venue') || 'okx';
      return lookupScreener(venue, { venue });
    },
    'GET api/whale': ({ searchParams }) => whaleLoader(searchParams.get('address') || ''),
    'POST api/whale/history': async (_url, request) => {
      const {address,hours} = await readBody(request);
      const [current, history] = await Promise.allSettled([whaleLoader(address),whaleHistoryLoader(address,{hours})]);
      if (current.status === 'rejected' && history.status === 'rejected') throw history.reason;
      const value = history.status === 'fulfilled' ? history.value : null;
      const reviewable = (item, suffix, label, unit, reading, quality, source, context) => {
        const fact = makeFact({key:'whale:'+suffix,venue:'hyperliquid',symbol:item.symbol,asOf:Date.parse(item.timestamp),
          label,unit,value:reading,quality,source,context});
        keepFact(fact);
        return fact;
      };
      const events = value?.events.map(item => ({...item,
        fact:reviewable(item,'after-fill','成交后重建净仓位','基础币',item.signedAfter,'estimated',value.source,
          {before:item.signedBefore,side:item.side,size:item.quantity,price:item.price}),
      }));
      const funding = value?.funding?.events.map(item => ({...item,
        fact:reviewable(item,'funding','公开账户资金费','USDC',item.amount,'measured',{...(value.funding.source ?? value.source),documentation:value.source.fundingDocumentation},
          {quantity:item.signedQuantity,ratePct:item.ratePct}),
      }));
      return {
        current:current.status === 'fulfilled' ? current.value : null,
        currentError:current.status === 'rejected' ? current.reason.message : null,
        history:value && {...value,events,funding:value.funding && {...value.funding,events:funding}},
        historyError:history.status === 'rejected' ? history.reason.message : null,
      };
    },
    'GET api/replay/list': async () => ({sessions:await recorder.list()}),
    'POST api/replay/start': async (_url,request) => ({session:await recorder.start(await readBody(request))}),
    'POST api/replay/stop': async (_url,request) => ({session:await recorder.stop((await readBody(request)).id)}),
    'POST api/replay/import': async (_url,request) => ({session:await recorder.importNDJSON((await readBody(request,34*1024*1024)).text)}),
    'GET api/replay/export': async ({searchParams}) => ({text:await recorder.exportNDJSON(searchParams.get('id'))}),
    'GET api/replay/frame': async ({searchParams}) => {
      const rawTime = searchParams.get('ts');
      const replay = await recorder.get({id:searchParams.get('id'),ts:rawTime === null ? undefined : Number(rawTime)});
      const {session,frame,liquidations,liquidationSource} = replay;
      const market = {venue:session.venue,symbol:session.symbol,asOf:frame?.ts,
        book:frame?.book,liquidations,sources:{book:frame?.sources?.book,liquidations:liquidationSource}};
      const keys = [
        ...(market.book?.bids ?? []).slice(0,12).map(row=>'book:bid:'+row.price),
        ...(market.book?.asks ?? []).slice(0,12).map(row=>'book:ask:'+row.price),
        ...liquidations.slice(0,60).map(row=>'liquidation:'+row.id),
      ];
      const audit = {};
      if (session.origin !== 'imported') for (const key of keys) {
        const fact = factForMarket(market,key);
        if (fact) {keepFact(fact);audit[key]=fact;}
      }
      return {...replay,audit};
    },
    'POST api/calculate': async (_url, request) => calculate(await readBody(request)),
    'GET api/reviews': async () => ({ reviews: await reviews.list() }),
    'POST api/reviews': async (_url, request) => {
      const { id, decision } = await readBody(request);
      const fact = facts.get(id) ?? (await reviews.list()).find(row => row.fact.id === id)?.fact;
      if (!fact) throw new Error('快照不在当前会话。请刷新行情后重试。');
      return { review: await reviews.set(fact, decision) };
    },
    'GET api/preferences': () => preferences(),
    'POST api/preferences': async (_url, request) => savePreferences(await readBody(request)),
    'GET api/analysis': () => analyze({}),
  };

  async function analyze({ ids } = {}) {
    const evidence = await reviews.approved({ ids });
    return {
      count: evidence.length,
      summary: evidence.length
        ? '下列数据由用户逐项核对。引用对应时间、来源和单位，模型结果仅表示估算。'
        : '还没有已确认的数据。请打开指标来源并逐项核对。',
      evidence,
    };
  }

  const server = createServer(async (request, response) => {
    const headers = {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
    };
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      response.writeHead(status, { ...headers, 'Content-Type': type });
      response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
    };
    try {
      const url = new URL(request.url, origin);
      if (request.headers.host !== new URL(origin).host || !url.pathname.startsWith(prefix)) {
        send(404, { error: '页面不存在。' }); return;
      }
      const path = url.pathname.slice(prefix.length);
      if (request.method === 'GET' && staticFiles.has(path)) {
        const [file, type] = staticFiles.get(path);
        send(200, await readFile(join(ui, file)), type); return;
      }
      if (request.method === 'POST' && (request.headers.origin !== origin || !/^application\/json\b/i.test(request.headers['content-type'] || ''))) {
        send(403, { error: '请求必须来自本机看板。' }); return;
      }
      const handler = routes[request.method + ' ' + path];
      if (!handler) { send(404, { error: '页面不存在。' }); return; }
      send(200, await handler(url, request));
    } catch (error) {
      send(error instanceof RangeError || error instanceof SyntaxError ? 400 : 422,
        { error: String(error?.message || '数据暂时不可用。').slice(0, 260) });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = 'http://127.0.0.1:' + server.address().port;
  return {
    url: origin + prefix,
    analyze,
    close: async () => {
      await recorder.close();
      await new Promise(resolve => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dashboard = await startDashboard();
  console.log(dashboard.url);
}
