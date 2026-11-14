import { evaluateAlerts } from './advanced.mjs';
import { createDrawingController } from './drawings.js';
import { setupMarketWatch } from './market-watch.js';

const $ = id => document.getElementById(id);
const state = {
  market: null, screener: null, window: '24h', series: 'oiUsd', cursor: 0, venue: 'okx',
  request: 0, scanRequest: 0, reviews: new Map(),
};
const venueName = {okx:'OKX',binance:'Binance',bybit:'Bybit',hyperliquid:'Hyperliquid'};
const metric = {
  price: ['最新价', ' USDT'], change: ['24h 涨跌', '%'], oi: ['未平仓量', ''], oiUsd: ['持仓名义价值',' USD'],
  funding: ['资金费率','%'], longRatio: ['账户多空比',' 倍'], book: ['盘口快照',''],
  trades: ['成交样本',''], candles: ['K 线',''], liquidations: ['公开强平',''],
};
const quality = { measured:'实测', estimated:'估算', missing:'缺失' };
const cn = new Intl.NumberFormat('zh-CN', {maximumFractionDigits:4});
const compact = new Intl.NumberFormat('zh-CN', {notation:'compact',maximumFractionDigits:2});
const clock = new Intl.DateTimeFormat('zh-CN', {timeZone:'Asia/Shanghai', month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const num = (value, short = false) => Number.isFinite(value) ? (short ? compact : cn).format(value) : '—';
const when = ts => Number.isFinite(ts) ? clock.format(ts) : '—';
const isoTime = value => typeof value === 'number' ? value : Date.parse(value);
const fmt = (key, value, short = false) => Number.isFinite(value) ?
  num(key === 'funding' ? value * 100 : value,short) + (metric[key]?.[1] || '') : '—';
const changeClass = v => v > 0 ? 'positive' : v < 0 ? 'negative' : '';
const el = (name, text, className) => {
  const node = document.createElement(name);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};
function button(label, onClick, className) {
  const node = el('button',label,className);
  node.type = 'button';
  node.addEventListener('click',onClick);
  return node;
}
function badge(key) { return el('span',quality[key] || quality.missing,'tag ' + key); }
function empty(node, text, error = false) { node.replaceChildren(el('p',text,error ? 'error' : 'empty')); }
const prefs = {watchlist: [], rules: [], events: [], drawings:{}};
const prefKey = {'tide-watchlist':'watchlist','tide-rules':'rules','tide-alert-history':'events'};
const loadPrefs = api('preferences').then(value=>Object.assign(prefs,value)).catch(()=>{});
function stored(key, fallback) { return prefs[prefKey[key]] ?? fallback; }
function store(key, value) {
  const field = prefKey[key];
  prefs[field] = value;
  void api('preferences',{[field]:value}).catch(error=>{
    if (!$('scan').hidden) $('live-status').textContent='保存提醒失败 · '+error.message;
  });
}
function link(url, title) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    const a = el('a',title || parsed.hostname);
    a.href = parsed.href; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  } catch { return null; }
}
async function api(path, body) {
  const options = body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)};
  const response = await fetch('api/' + path, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败。');
  return result;
}
function table(parent, heads, rows, noRows) {
  if (!rows.length) return empty(parent,noRows || '暂无可用数据。');
  const wrap = el('div',null,'table-wrap'), t = el('table'), header = el('thead'), tr = el('tr'), body = el('tbody');
  heads.forEach(value => { const cell = el('th',value); cell.scope = 'col'; tr.append(cell); });
  header.append(tr);
  rows.forEach(row => {
    const line = el('tr');
    row.forEach(value => {
      const cell = el('td');
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value ?? '—';
      line.append(cell);
    });
    body.append(line);
  });
  t.append(header,body); wrap.append(t); parent.replaceChildren(wrap);
}
function keyName(key) { return metric[key]?.[0] || key; }
function stateOf(market,key) {
  if (key in (market.metrics || {}) && !Number.isFinite(market.metrics[key])) return 'missing';
  return market.sources?.[key]?.quality || (market.errors?.[key] ? 'missing' : 'measured');
}
function sourceBody(source, error, raw) {
  const box = document.createDocumentFragment();
  if (source?.label) box.append(el('p',source.label));
  if (source?.method) box.append(el('p',source.method));
  const a = link(source?.url,'打开原始接口');
  if (a) box.append(a);
  const documentation=link(source?.documentation ?? source?.docs,'查看接口文档');
  if(documentation) box.append(' · ',documentation);
  if (error) box.append(el('p',error,'empty'));
  if (raw !== undefined) {
    const details = el('details');
    details.append(el('summary','查看原始字段'),el('pre',JSON.stringify(raw,null,2)));
    box.append(details);
  }
  return box;
}
function showEvidence(title, source, error, raw, fact, fallbackQuality) {
  $('evidence-title').textContent = title;
  const flags = badge(fact?.quality || source?.quality || fallbackQuality || (error ? 'missing' : 'measured'));
  $('evidence-body').replaceChildren(flags,sourceBody(fact?.source || source,error,raw));
  $('evidence-status').textContent = '';
  const actions = $('evidence-actions');
  actions.replaceChildren();
  if (fact) {
    const label = fact.venue.toUpperCase() + ' · ' + fact.symbol + ' · ' + when(fact.asOf) + ' UTC+8';
    const type = fact.key.startsWith('series:') ? fact.key.split(':')[1] : fact.key;
    const isMetric = Object.hasOwn(metric,type);
    const reading=fact.unit==='UTC 毫秒'?new Date(fact.value).toISOString():isMetric?fmt(type,fact.value):num(fact.value)+' '+fact.unit;
    $('evidence-body').prepend(el('p',label),el('p',reading));
    if (fact.context) $('evidence-body').append(sourceBody(null,null,fact.context));
    for (const [decision,text] of [['approve','确认此数据'],['reject','拒绝'],['revoke','撤回确认']]) {
      actions.append(button(text, async () => {
        [...actions.children].forEach(b=>b.disabled=true);
        try {
          await api('reviews',{id:fact.id,decision});
          $('evidence-status').textContent = decision === 'approve' ? '已确认此快照。' : '已更新核对状态。';
          await loadReviews();
        } catch (e) { $('evidence-status').textContent = e.message; }
        finally { [...actions.children].forEach(b=>b.disabled=false); }
      }, decision === 'approve' ? 'action' : ''));
    }
  }
  if (!$('evidence').open) $('evidence').showModal();
}
async function openFact(key, title, sourceField, raw) {
  const m = state.market;
  if (!m) return;
  try {
    const query = new URLSearchParams({snapshot:m.snapshotId,key});
    const fact = m.audit?.[key] || (await api('fact?' + query)).fact;
    showEvidence(title,m.sources?.[sourceField],m.errors?.[sourceField],raw,fact,stateOf(m,sourceField));
  } catch (e) { showEvidence(title,m.sources?.[sourceField],e.message,raw,null,stateOf(m,sourceField)); }
}
function marketSource(key, raw) {
  const m = state.market;
  if (!m) return;
  showEvidence(keyName(key),m.sources?.[key],m.errors?.[key],raw,m.audit?.[key],stateOf(m,key));
}
function modelSource() {
  const model = state.market?.model;
  if (!model) return;
  showEvidence('估算清算模型',{...model.source,method:model.method,quality:model.quality},model.reason,
    {coverage:model.coverage,leverage:model.leverage,marginRate:model.marginRate,assumptions:model.assumptions},null,model.quality);
}
function valuesInWindow(rows, ts) {
  const m = state.market, candles = m.candles;
  if (!Number.isFinite(ts) || candles.length < 2) return rows;
  const step = candles[1].ts - candles[0].ts;
  return rows.filter(x => x.ts >= ts && x.ts < ts + step);
}
function drawBase(element, low, high, times, noData, domain = times) {
  const rect = element.getBoundingClientRect(), dw = Math.max(1,rect.width), dh = Math.max(1,rect.height), dpr = devicePixelRatio || 1;
  element.width = Math.round(dw*dpr); element.height = Math.round(dh*dpr);
  const g = element.getContext('2d');
  g.scale(dpr,dpr); g.clearRect(0,0,dw,dh);
  g.font = '11px ui-monospace, monospace'; g.fillStyle = '#9eb3c0';
  if (!times.length || !Number.isFinite(low) || !Number.isFinite(high)) {
    g.textAlign = 'center'; g.fillText(noData,dw/2,dh/2);
    return;
  }
  const left = 10, right = Math.max(dw - 70,24), top = 12, bottom = Math.max(dh - 27,22);
  const min = domain[0], max = domain.at(-1), step = Math.max(max - min,1);
  const delta = Math.max(high-low,Math.abs(high)*0.00001,0.00001);
  const x = ts => left + ((ts-min)/step)*(right-left);
  const y = v => bottom - ((v-low)/delta)*(bottom-top);
  for (let i=0;i<=4;i++) {
    const py = top + (bottom-top)*i/4;
    g.strokeStyle='#223747'; g.beginPath(); g.moveTo(left,py); g.lineTo(right,py); g.stroke();
    g.textAlign='left'; g.fillText(num(low+delta*(1-i/4),true),right+5,py+4);
  }
  for (let i=0;i<=3;i++) {
    const px = left+(right-left)*i/3;
    g.textAlign=i===0?'left':i===3?'right':'center';
    g.fillText(when(min+(max-min)*i/3),px,dh-7);
  }
  return {g,x,y,top,bottom,left,right,min,max,low,high:low+delta};
}
function vertical(base, ts) {
  if (!base || !Number.isFinite(ts)) return;
  const {g,x,top,bottom} = base;
  g.strokeStyle = '#85e9db';
  g.setLineDash([4,4]);g.beginPath();g.moveTo(x(ts),top);g.lineTo(x(ts),bottom);g.stroke();g.setLineDash([]);
}
let drawingFrame;
const drawingHint = {
  horizontal:'在图表上选一个价格，或用方向键定位后按 Enter。',
  trend:'选两个时间与价格锚点，或用方向键和 Enter。',
  measure:'选两个锚点计算价差、涨跌幅和时间差。',
};
const drawings=createDrawingController({
  load:key=>prefs.drawings?.[key] ?? [],
  save(key,items){
    prefs.drawings[key]=items;
    return api('preferences',{drawing:{key,items}});
  },
  change(data){
    $('drawing-tools').querySelectorAll('[data-draw]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.draw===data.tool));
    $('drawing-undo').disabled=!data.items.length;
    $('drawing-clear').disabled=!data.items.length;
    $('price-chart').dataset.drawing=data.tool!=='cursor';
    $('price-chart').setAttribute('aria-label',data.tool==='cursor'?'价格 K 线，左右方向键移动时间':
      '绘图。方向键移动，Enter 固定锚点，Escape 取消');
    const m=data.measurement;
    const measurement=m?'价差 '+num(m.priceChange)+' USDT · '+num(m.percentChange)+'% · '+num(m.elapsedMs/60_000)+' 分钟':'';
    $('drawing-status').textContent=data.storageError || (data.tool==='cursor' ? '' :
      (data.tool==='measure'&&measurement ? measurement : data.anchor?'请选择第二个锚点。':drawingHint[data.tool]));
    cancelAnimationFrame(drawingFrame);
    drawingFrame=requestAnimationFrame(drawCharts);
  },
});
$('drawing-tools').addEventListener('click',event=>{
  const b=event.target.closest('[data-draw]');
  if(b){drawings.setTool(b.dataset.draw);$('price-chart').focus({preventScroll:true});}
});
$('drawing-undo').onclick=()=>drawings.undo();
$('drawing-clear').onclick=()=>drawings.clear();
$('drawing-source').onclick=()=>{
  const {items,measurement}=drawings.snapshot();
  showEvidence('图表标注与测距',{label:'本机绘图',quality:'estimated',
    method:'锚点取图表坐标对应的 UTC 时间与 USDT 价格。价差 = 终点 − 起点，涨跌幅 = 价差 ÷ 起点 × 100%，时长 = 两点时间差的绝对值。标注按交易所和币种保存在本机。'},
    null,{markCount:items.length,lastDrawing:items.at(-1),measurement},null,'estimated');
};
function currentCandle() { return state.market?.candles[state.cursor]; }
function drawCharts() {
  const m = state.market;
  if (!m || $('market').hidden) return;
  const candles = m.candles;
  const times = candles.map(p=>p.ts), point = currentCandle();
  const price = drawBase($('price-chart'),Math.min(...candles.map(c=>c.low)),Math.max(...candles.map(c=>c.high)),times,'K 线暂缺');
  drawings.setBase(price ?? null);
  if (price) {
    const {g,x,y,left,right} = price;
    const width = Math.max(1, Math.min(11, (right-left)/Math.max(candles.length,1)*.72));
    candles.forEach(c=>{
      g.strokeStyle=g.fillStyle=c.close>=c.open?'#58dfb4':'#ff9099';
      g.beginPath();g.moveTo(x(c.ts),y(c.high));g.lineTo(x(c.ts),y(c.low));g.stroke();
      g.fillRect(x(c.ts)-width/2,Math.min(y(c.open),y(c.close)),width,Math.max(1,Math.abs(y(c.open)-y(c.close))));
    });
    vertical(price,point?.ts);
    drawings.render();
  }
  const model = m.model, heatTimes = [...new Set(model.cells.map(c=>c.ts))].sort((a,b)=>a-b);
  const heat = drawBase($('heat-chart'),model.priceRange?.[0],model.priceRange?.[1],heatTimes,'当前区间无足够持仓增量',times.length?times:heatTimes);
  if (heat) {
    const {g,x,y,left,right} = heat, width = Math.max(2,(right-left)/Math.max(heatTimes.length-1,1));
    model.cells.forEach(cell=>{
      const opacity = Math.min(.94,.09 + .85*Math.sqrt(cell.intensity));
      g.fillStyle = cell.side === 'long' ? 'rgba(54,205,177,'+opacity+')' : 'rgba(246,148,93,'+opacity+')';
      g.fillRect(x(cell.ts) - width/2,y(cell.priceHigh),width,Math.max(1,y(cell.price)-y(cell.priceHigh)));
    });
    vertical(heat,point?.ts);
  }
  const series = m.series[state.series] || [], st = series.map(x=>x.ts);
  const factor = state.series === 'funding' ? 100 : 1;
  const range = series.map(x=>x.value*factor);
  const chart = drawBase($('series-chart'),Math.min(...range),Math.max(...range),st,'此序列暂缺',times.length?times:st);
  if (chart) {
    const {g,x,y}=chart; g.strokeStyle='#70e4cf';g.lineWidth=1.5;g.beginPath();
    series.forEach((p,i)=>i===0?g.moveTo(x(p.ts),y(p.value*factor)):g.lineTo(x(p.ts),y(p.value*factor)));g.stroke();
    if (point && st[0]<=point.ts && point.ts<=st.at(-1)) vertical(chart,point.ts);
  }
}
function renderTrades(point) {
  const m=state.market, rows=valuesInWindow(m.trades,point?.ts);
  const buckets=[['低于 1 千',0,1000],['1 千–1 万',1000,10000],['1 万–10 万',10000,100000],['10 万及以上',100000,Infinity]];
  const grouped=buckets.map(([label,min,max])=>{
    const trades=rows.filter(t=>t.notional>=min&&t.notional<max);
    const total=side=>trades.filter(t=>t.side===side).reduce((sum,t)=>sum+t.notional,0);
    return [label,num(trades.length),el('span',num(total('buy'),true),'positive'),el('span',num(total('sell'),true),'negative')];
  });
  if (!rows.length) return empty($('trades'),m.errors?.trades || '选中时间段无可用逐笔样本。');
  const parent=$('trades'), summary=el('div');
  table(summary,['名义价值 USDT','笔数','主动买','主动卖'],grouped);
  const detail=el('details'), transactions=el('div');
  detail.append(el('summary','核对逐笔成交'));
  table(transactions,['时间','方向','名义价值'],rows.slice(0,20).map(x=>[
    when(x.ts),x.side==='buy'?'买':'卖',
    button(num(x.notional,true),()=>openFact('trade:'+x.id,'逐笔成交','trades',x),'source-link'),
  ]));
  detail.append(transactions);
  const delta=rows.reduce((sum,t)=>sum+(t.side==='buy'?1:-1)*t.notional,0);
  parent.replaceChildren(el('p','样本主动买卖名义差 '+num(delta,true)+' USDT · '+rows.length+' 笔'),summary,detail);
}
function updateCursor(value) {
  const m=state.market;
  if (!m) return;
  state.cursor=Math.max(0,Math.min(m.candles.length-1,value));
  $('time').value=state.cursor;
  const c=currentCandle();
  $('hover-info').textContent=c?when(c.ts)+' UTC+8 · 开 '+num(c.open)+' · 高 '+num(c.high)+' · 低 '+num(c.low)+' · 收 '+num(c.close):'';
  drawCharts(); renderTrades(c);
}
function renderMarket() {
  const m=state.market;
  $('pair').textContent=m.symbol+' / USDT';
  $('chart-time').textContent=venueName[m.venue]+' · '+m.window+' · UTC+8';
  const keys=['price','change','oi','oiUsd','funding','longRatio'];
  $('metrics').replaceChildren(...keys.map(key=>{
    const b=button('',()=>marketSource(key,m.metrics[key]),'metric');
    b.append(el('small',keyName(key)),el('strong',fmt(key,m.metrics[key],['oi','oiUsd'].includes(key)),key==='change'?changeClass(m.metrics[key]):''),badge(stateOf(m,key)));
    return b;
  }));
  const book=m.book;
  const rows=(side)=> (book?.[side] || []).slice(0,8).map(x=>[
    side==='asks'?'卖':'买',num(x.price),num(x.size),
    button(num(x.notional,true),()=>openFact('book:'+(side==='asks'?'ask':'bid')+':'+x.price,'单档挂单','book',x),'source-link'),
  ]);
  table($('book'),['方向','价格','数量','名义价值'],[...rows('asks').reverse(),...rows('bids')],m.errors?.book);
  if (book?.ts) $('book').prepend(el('p','快照 '+when(book.ts)+' UTC+8'));
  table($('levels'),['方向','价位','强度'],m.model.levels.slice(0,14).map(x=>[
    el('span',x.side==='long'?'多头':'空头',x.side==='long'?'positive':'negative'),num(x.price),
    button(num(x.intensity*100)+'%',()=>openFact('model:'+x.side+':'+x.price,'估算清算价位','oi',x),'source-link'),
  ]),m.model.reason || '此区间没有可报告的模型价位。');
  $('heat-note').textContent=m.model.quality==='missing'?(m.model.reason || '模型输入缺失。'):'基于公开持仓增量 · 色值为无量纲相对强度';
  table($('liquidations'),['时间 UTC+8','被强平一侧','价格','名义价值'],m.liquidations.slice(0,18).map(x=>[
    when(x.ts),x.side==='long'?'多头':'空头',num(x.price),
    button(num(x.notional,true),()=>openFact('liquidation:'+x.id,'公开强平成交','liquidations',x),'source-link'),
  ]),m.errors?.liquidations || '本区间暂无可用的交易所公开样本。');
  $('series-controls').replaceChildren(...['oiUsd','oi','funding','longRatio'].map(key=>{
    const b=button(keyName(key),()=>{state.series=key;renderMarket();});
    b.setAttribute('aria-pressed',key===state.series); return b;
  }));
  $('time').max=Math.max(0,m.candles.length-1);$('time').disabled=!m.candles.length;
  updateCursor(state.cursor);
}
async function loadMarket() {
  const request=++state.request, venue=$('venue').value, symbol=$('symbol').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return empty($('market-message'),'请输入币种简称。',true);
  const q = new URLSearchParams({venue,symbol,window:state.window});
  $('symbol').value=symbol;
  empty($('market-message'),'正在查询 '+venueName[venue]+' '+symbol+'…');
  try {
    const m=await api('market?' + q);
    if (request!==state.request) return;
    await loadPrefs;
    if(request!==state.request)return;
    state.market=m;state.venue=venue;state.cursor=m.candles.length-1;
    drawings.setMarket(m.venue,m.symbol);
    const available=Object.values(m.metrics).some(Number.isFinite) || m.candles.length>0;
    $('live-status').textContent=m.demo?'演示数据 · '+when(m.asOf)+' UTC+8':available?venueName[venue]+' · '+when(m.asOf)+' UTC+8':'行情源暂不可用';
    if (available) $('market-message').replaceChildren();
    else empty($('market-message'),'当前行情接口不可达。检查网络后重试，缺失值已保留。',true);
    renderMarket();
  } catch (e) {
    if(request===state.request) empty($('market-message'),e.message,true);
  }
}
function getWatchlist() { return new Set(stored('tide-watchlist',[])); }
function renderScanner() {
  const s=state.screener;
  if (!s) return;
  const key=$('sort').value, sign=$('direction').value==='asc'?1:-1;
  const filter=$('search-symbol').value.trim().toUpperCase(), watch=getWatchlist();
  const rows=s.rows.filter(x=>x.symbol.includes(filter)&&(!$('watch-only').checked||watch.has(x.symbol)));
  rows.sort((a,b)=>Number.isFinite(a[key])&&Number.isFinite(b[key])?sign*(a[key]-b[key]):Number.isFinite(a[key])?-1:Number.isFinite(b[key])?1:0);
  table($('scanner'),['币种','价格','24h 涨跌','成交额','名义持仓','资金费率','关注'],rows.slice(0,80).map(r=>[
    button(r.symbol,()=>{ $('symbol').value=r.symbol;activate('market');void loadMarket(); },'pair-button'),
    fmt('price',r.price),el('span',fmt('change',r.change),changeClass(r.change)),
    num(r.turnover,true),fmt('oiUsd',r.oiUsd,true),fmt('funding',r.funding),
    button(watch.has(r.symbol)?'取消':'关注',()=>{ if(watch.has(r.symbol))watch.delete(r.symbol);else watch.add(r.symbol);store('tide-watchlist',[...watch]);renderScanner(); }),
  ]),'没有匹配的合约。');
  $('scanner').prepend(el('p',venueName[s.venue]+' · '+when(s.asOf)+' UTC+8 · '+rows.length+' 个合约，最多显示 80 个'));
  renderAlerts();
}
async function loadScanner() {
  const request=++state.scanRequest;
  empty($('scanner'),'正在查询 '+venueName[$('venue').value]+' 公开合约…');
  try {
    const result=await api('screener?'+new URLSearchParams({venue:$('venue').value}));
    if(request!==state.scanRequest)return;
    await loadPrefs;
    if(request!==state.scanRequest)return;
    state.screener=result; renderScanner();
    if(!result.rows.length) empty($('scanner'),Object.values(result.errors || {})[0] || '交易所没有返回可用数据。',true);
  } catch(e) { if(request===state.scanRequest)empty($('scanner'),e.message,true); }
}
function renderAlerts() {
  const parent=$('alerts'), rules=stored('tide-rules',[]);
  const rows=state.screener?.rows||[];
  const normalized=rows.map(x=>({
    symbol:x.symbol,changePct:Number.isFinite(x.change)?Math.abs(x.change):null,
    fundingRatePct:Number.isFinite(x.funding)?x.funding*100:null,oiUsd:x.oiUsd,
    volumeUsd:x.turnover,timestamp:state.screener?.asOf,
  }));
  const {matches}=evaluateAlerts(rules,normalized);
  const alerts=stored('tide-alert-history',[]);
  const oldCount = alerts.length;
  for (const x of matches) {
    const eventId=[$('venue').value,x.ruleId,x.symbol,x.timestamp].join(':');
    if(!alerts.some(a=>a.eventId===eventId))alerts.unshift({...x,eventId});
  }
  if (alerts.length!==oldCount) store('tide-alert-history',alerts.slice(0,50));
  if(!rules.length&&!alerts.length)return empty(parent,'保存阈值后，刷新排名或保持此页打开以检查异动。');
  const list=el('div');
  for(const rule of rules){
    const row=el('div',null,'rule');
    const tag=el('span',rule.symbol+' · |24h 涨跌| ≥ '+rule.threshold+'%');
    row.append(tag,button('移除',()=>{store('tide-rules',rules.filter(r=>r.id!==rule.id));renderAlerts();})); list.append(row);
  }
  const history=el('div');
  table(history,['触发时间','币种','变动','阈值'],alerts.slice(0,15).map(a=>[when(a.timestamp),a.symbol,num(a.value)+'%',num(a.threshold)+'%']),'暂无匹配记录。');
  parent.replaceChildren(list,history);
}
function activate(tab) {
  for(const b of $('tabs').querySelectorAll('button')){
    const selected=b.dataset.tab===tab;
    if(selected)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current');
    $(b.dataset.tab).hidden=!selected;
  }
  if(tab==='market')drawCharts();
  if(tab==='scan')void loadScanner();
  if(tab==='review')void loadReviews();
  if(tab==='replay')void replayList();
  if(tab!=='replay')pauseReplay();
  if(tab==='whale')drawWhale();
  marketWatch.onActivate(tab);
}
$('tabs').addEventListener('click',e=>{ const b=e.target.closest('[data-tab]'); if(b)activate(b.dataset.tab); });
$('market-form').addEventListener('submit',e=>{e.preventDefault();void loadMarket();});
$('venue').addEventListener('change',()=>void loadMarket());
$('windows').addEventListener('click',e=>{
  const b=e.target.closest('[data-window]');if(!b)return;
  state.window=b.dataset.window;
  $('windows').querySelectorAll('button').forEach(x=>x.setAttribute('aria-pressed',x===b));
  void loadMarket();
});
$('time').addEventListener('input',e=>updateCursor(Number(e.target.value)));
for(const id of ['price-chart','heat-chart','series-chart']){
  const chart=$(id);
  chart.addEventListener('pointermove',event=>{
    if(id==='price-chart'&&drawings.pointer(event))return;
    const candles=state.market?.candles||[];
    if(!candles.length)return;
    const rect=chart.getBoundingClientRect();
    const fraction=Math.max(0,Math.min(1,(event.clientX-rect.left-10)/Math.max(rect.width-80,1)));
    const cursor=Math.round(fraction*(candles.length-1));
    if(cursor!==state.cursor)updateCursor(cursor);
  });
  chart.addEventListener('keydown',event=>{
    if(id==='price-chart'&&drawings.key(event))return;
    if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();updateCursor(state.cursor+(event.key==='ArrowLeft'?-1:1));
  });
}
$('price-chart').addEventListener('click',event=>drawings.click(event));
$('price-chart').addEventListener('pointerleave',()=>drawings.leave());
$('price-source').onclick=()=>{
  const c=currentCandle();
  if(c)void openFact('candle:'+c.ts,'K 线收盘价','candles',c);
  else marketSource('candles');
};
$('book-source').onclick=()=>marketSource('book',state.market?.book);
$('trade-source').onclick=()=>marketSource('trades',state.market?.trades.slice(0,8));
$('liq-source').onclick=()=>marketSource('liquidations',state.market?.liquidations.slice(0,8));
$('model-source').onclick=modelSource;
$('structure-source').onclick=()=>{
  const key=state.series, clock=currentCandle()?.ts, rows=state.market?.series?.[key]||[];
  const point=rows.length?rows.reduce((best,x)=>Math.abs(x.ts-clock)<Math.abs(best.ts-clock)?x:best,rows[0]):null;
  if(point&&Number.isFinite(clock))void openFact('series:'+key+':'+point.ts,keyName(key),key,point);
  else marketSource(key);
};
$('scan-source').onclick=()=>{
  if(!state.screener)return;
  const s=state.screener;
  showEvidence('排名来源',{label:venueName[s.venue],method:'使用公开合约快照，并按界面选择的字段排序。'},null,{sources:s.sources,errors:s.errors},null,'measured');
  for(const entry of Object.values(s.sources || {})){
    const a=link(entry.url,entry.label);
    if(a){const line=el('p');line.append(a);$('evidence-body').append(line);}
  }
};
$('refresh-scan').onclick=()=>void loadScanner();
for(const id of ['direction','sort','search-symbol','watch-only'])$(id).addEventListener('input',renderScanner);
$('alert-form').addEventListener('submit',event=>{
  event.preventDefault();
  const symbol=$('alert-symbol').value.trim().toUpperCase(), threshold=Number($('alert-change').value);
  if(!/^[A-Z0-9]{1,12}$/.test(symbol)||!Number.isFinite(threshold)||threshold<=0)return;
  const rules=stored('tide-rules',[]);
  rules.push({id:crypto.randomUUID(),symbol,metric:'changePct',operator:'gte',threshold});store('tide-rules',rules);renderAlerts();
});
let whaleHistory = null;
const whaleAction={open:'开仓',add:'加仓',reduce:'减仓',close:'平仓',flip:'反手'};
function drawWhale() {
  if ($('whale').hidden) return;
  const position=whaleHistory?.positions.find(x=>x.symbol===$('whale-symbol').value);
  const points=(position?.points ?? []).map(x=>({...x,ts:isoTime(x.timestamp)})).filter(x=>Number.isFinite(x.ts));
  const values=points.map(x=>x.signedQuantity).filter(Number.isFinite);
  const chart=drawBase($('whale-chart'),Math.min(0,...values),Math.max(0,...values),values.length?points.map(x=>x.ts):[],
    '没有可绘制的净仓位点');
  if (!chart) return;
  const {g,x,y,left,right}=chart;
  g.strokeStyle='#48606e';g.beginPath();g.moveTo(left,y(0));g.lineTo(right,y(0));g.stroke();
  g.strokeStyle='#64e7cd';g.fillStyle='#64e7cd';g.lineWidth=1.5;
  let previous=null;
  for(const p of points) {
    if(!Number.isFinite(p.signedQuantity)){previous=null;continue;}
    if(previous){
      g.setLineDash([4,3]);g.beginPath();g.moveTo(x(previous.ts),y(previous.signedQuantity));g.lineTo(x(p.ts),y(previous.signedQuantity));g.stroke();
      g.setLineDash([]);g.beginPath();g.moveTo(x(p.ts),y(previous.signedQuantity));g.lineTo(x(p.ts),y(p.signedQuantity));g.stroke();
    }
    g.beginPath();g.arc(x(p.ts),y(p.signedQuantity),2.3,0,Math.PI*2);g.fill();
    previous=p;
  }
}
function whaleHistorySource(part='main') {
  if(!whaleHistory)return;
  const h=whaleHistory, section=part==='funding'?h.funding:h;
  if(!section)return;
  showEvidence(part==='funding'?'账户资金费来源':'公开地址仓位重建',
    {...(section.source ?? h.source),...(part==='funding'&&{documentation:h.source.fundingDocumentation}),
      quality:section.coverage?.status==='missing'?'missing':part==='funding'?'measured':'estimated'},
    section.coverage?.reason,{coverage:section.coverage,from:h.start,to:h.end},null);
}
function renderWhaleHistory() {
  const h=whaleHistory;
  drawWhale();
  if(!h)return;
  const rows=h.events.filter(x=>x.symbol===$('whale-symbol').value);
  table($('whale-events'),['时间 UTC+8','动作','成交价','成交前仓位','成交后仓位'],rows.slice(-150).reverse().map(item=>[
    when(isoTime(item.timestamp)),whaleAction[item.action]||item.action,num(item.price),num(item.signedBefore),
    button(num(item.signedAfter),()=>showEvidence('成交后重建净仓位',{...h.source,quality:'estimated'},null,item.raw ?? item,item.fact,'estimated'),'source-link'),
  ]), '所选币种在本区间没有可用的公开逐笔成交。');
  const funding=(h.funding?.events ?? []).filter(x=>!$('whale-symbol').value||x.symbol===$('whale-symbol').value);
  table($('whale-funding'),['结算时间 UTC+8','币种','资金费 USDC','费率'],funding.slice(-100).reverse().map(item=>[
    when(isoTime(item.timestamp)),item.symbol,
    button(num(item.amount),()=>showEvidence('公开资金费流水',{...(h.funding.source ?? h.source),documentation:h.source.fundingDocumentation},null,item.raw ?? item,item.fact,'measured'),'source-link'),
    Number.isFinite(item.ratePct)?num(item.ratePct)+'%':'—',
  ]),h.funding?.coverage?.reason || '选中币种暂无可用资金费记录。');
}
$('whale-source').onclick=()=>whaleHistorySource();
$('whale-funding-source').onclick=()=>whaleHistorySource('funding');
$('whale-symbol').onchange=renderWhaleHistory;
$('whale-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const parent=$('whale-results'),btn=event.submitter;
  btn.disabled=true;empty(parent,'正在读取 Hyperliquid 公开持仓…');
  whaleHistory=null;
  $('whale-symbol').disabled=$('whale-source').disabled=$('whale-funding-source').disabled=true;
  $('whale-symbol').replaceChildren(new Option('选择币种',''));
  $('whale-coverage').textContent='正在读取公开历史…';
  $('whale-events').replaceChildren();$('whale-funding').replaceChildren();drawWhale();
  try{
    const {current,history,currentError,historyError}=await api('whale/history',{
      address:$('whale-address').value.trim(),hours:Number($('whale-hours').value),
    });
    if(current){
      const summary=el('p','账户价值 '+num(current.summary.accountValue,true)+' USD · 名义持仓 '+num(current.summary.totalNotional,true)+' USD · '+when(isoTime(current.timestamp))+' UTC+8');
      const details=el('div');
      table(details,['币种','方向','数量','平均入场','强平价','未实现盈亏'],current.positions.map(r=>[
        button(r.symbol,()=>showEvidence('Hyperliquid 公开仓位',current.source,null,r,null,'measured'),'source-link'),
        r.side==='long'?'多':'空',num(r.quantity),num(r.entryPrice),num(r.liquidationPrice),num(r.unrealizedPnl),
      ]),'此地址没有公开的永续仓位。');
      parent.replaceChildren(summary,details,button('账户来源',()=>showEvidence('Hyperliquid 公开地址',current.source,null,current,null,'measured'),'source-link'));
    }else empty(parent,currentError || '当前持仓暂时不可用。',true);
    if(history){
      whaleHistory=history;
      $('whale-coverage').textContent=[history.coverage?.status==='partial'?'部分覆盖':history.coverage?.status==='missing'?'缺失':'可见区间',
        when(isoTime(history.start))+'–'+when(isoTime(history.end))+' UTC+8',history.coverage?.reason].filter(Boolean).join(' · ');
      const symbols=[...new Set([...history.positions.map(p=>p.symbol),...(history.funding?.events??[]).map(f=>f.symbol)])];
      $('whale-symbol').replaceChildren(...(symbols.length?symbols.map(symbol=>new Option(symbol,symbol)):[new Option('无可用币种','')]));
      $('whale-symbol').disabled=!symbols.length;
      $('whale-source').disabled=false;
      $('whale-funding-source').disabled=!history.funding;
      renderWhaleHistory();
    }else $('whale-coverage').textContent=historyError || '持仓历史暂时不可用。';
  }catch(e){empty(parent,e.message,true);$('whale-coverage').textContent='持仓历史暂时不可用。';}
  finally{btn.disabled=false;}
});
const playback={id:null,index:0,timeline:[],details:null,request:0,listRequest:0,timer:null,playing:false,activeId:null};
function replaySessionTitle(s) {
  const labels={recording:'录制中',stopped:'已停止',interrupted:'已中断',limit:'达到上限',error:'采集中断'};
  return venueName[s.venue]+' '+s.symbol+' · '+when(s.startedAt)+' · '+(s.origin==='imported'?'导入':labels[s.state]||s.state);
}
function replayButtons() {
  const has=playback.timeline.length>0;
  $('replay-cursor').disabled=!has;
  $('replay-cursor').max=Math.max(0,playback.timeline.length-1);
  $('replay-cursor').value=playback.index;
  $('replay-prev').disabled=!has||playback.index===0;
  $('replay-next').disabled=!has||playback.index>=playback.timeline.length-1;
  $('replay-play').disabled=playback.timeline.length<2;
  $('replay-play').textContent=playback.playing?'暂停':'播放';
}
function pauseReplay() {
  playback.playing=false;clearTimeout(playback.timer);replayButtons();
}
function chooseReplay(id) {
  if (!id || id===playback.id) return;
  pauseReplay();
  playback.request++;
  playback.id=id;playback.index=0;playback.timeline=[];playback.details=null;
  replayButtons();
  empty($('replay-book'),'正在读取所选记录…');$('replay-liquidations').replaceChildren();
  void loadReplay(null,true);
}
async function replayList(preferred) {
  const request=++playback.listRequest;
  try {
    const {sessions}=await api('replay/list');
    if(request!==playback.listRequest)return;
    playback.activeId=sessions.find(s=>s.state==='recording')?.id ?? null;
    $('replay-start').disabled=Boolean(playback.activeId);
    $('replay-stop').disabled=!playback.activeId;
    const select=$('replay-sessions');
    select.replaceChildren(...(sessions.length?sessions.map(s=>new Option(replaySessionTitle(s),s.id)):[new Option('暂无记录','')]));
    select.disabled=!sessions.length;
    const id=[preferred,playback.id,playback.activeId,sessions[0]?.id].find(v=>sessions.some(s=>s.id===v));
    if(id){select.value=id;chooseReplay(id);}
  }catch(e){$('replay-status').textContent=e.message;}
}
function replayEvidence(kind,item,key) {
  const d=playback.details;
  if(!d)return;
  const imported=d.session.origin==='imported';
  const source=kind==='book'?d.frame?.sources?.book:kind==='liquidations'?d.liquidationSource:null;
  const book=kind==='book';
  const title=book?'回放盘口快照':kind==='liquidations'?'交易所公开强平':'采集范围与时间对齐';
  const meta={recordedAt:d.frame?.ts,bookTimestamp:d.frame?.book?.ts,requestedAt:d.requestedAt,
    gaps:d.frame?.gaps,streamStatus:d.frame?.streamStatus,stale:d.stale,origin:d.session.origin};
  const gap=imported?'本机导入数据，来源由文件声明，尚未独立核实。':
    (book&&d.stale?'离选择的时刻较远，请核对快照时间。':undefined);
  const method=source?.method || '回放按实际记录时间对齐，显示选中时间之前最近的盘口快照。强平按交易所事件时间展示。录制期间可能有轮询、推送或网络缺口。';
  const defined={...source,label:source?.label||title,method,quality:imported?'missing':source?.quality || (kind==='all'?'estimated':'missing')};
  showEvidence(title,defined,gap,item?{row:item,...meta}:meta,imported?null:d.audit?.[key],defined.quality);
}
for(const [id,kind] of [['replay-source','all'],['replay-book-source','book'],['replay-liquidation-source','liquidations']]){
  $(id).onclick=()=>replayEvidence(kind);
}
function renderReplay(d) {
  const f=d.frame;
  const coverage=(f?.gaps??[]).join(' · ');
  $('replay-status').textContent=[replaySessionTitle(d.session),d.session.frames+' 个盘口采样时点',
    d.session.origin==='imported'?'导入记录，来源待核实':null,coverage].filter(Boolean).join(' ｜ ');
  $('replay-time').textContent=[when(d.requestedAt)+' UTC+8',f?.book?.ts?'盘口快照 '+when(f.book.ts):'当前没有盘口快照',
    d.stale?'盘口快照距当前帧较远':null].filter(Boolean).join(' · ');
  $('replay-export').disabled=d.session.state==='recording';
  $('replay-source').disabled=$('replay-book-source').disabled=$('replay-liquidation-source').disabled=false;
  const rows=(side)=>(f?.book?.[side]??[]).slice(0,12).map(row=>[
    el('span',side==='bids'?'买':'卖',side==='bids'?'positive':'negative'),num(row.price),num(row.size),
    button(num(row.notional,true),()=>replayEvidence('book',row,'book:'+(side==='bids'?'bid':'ask')+':'+row.price),'source-link'),
  ]);
  table($('replay-book'),['方向','价格','数量','名义价值 USDT'],[...rows('asks').reverse(),...rows('bids')],'所选时刻没有可用盘口快照。');
  table($('replay-liquidations'),['时间 UTC+8','被强平一侧','参考价','名义价值 USDT'],d.liquidations.slice(0,60).map(row=>[
    when(row.ts),row.side==='long'?'多头':'空头',num(row.price),
    button(num(row.notional,true),()=>replayEvidence('liquidations',row,'liquidation:'+row.id),'source-link'),
  ]), '当前时间片未收到公开强平样本。');
  replayButtons();
}
async function loadReplay(ts,latest=false) {
  const request=++playback.request, id=playback.id;
  if(!id)return false;
  try{
    const q=new URLSearchParams({id});
    if(Number.isFinite(ts))q.set('ts',ts);
    const d=await api('replay/frame?'+q);
    if(request!==playback.request||id!==playback.id)return false;
    playback.details=d;playback.timeline=d.timeline;
    playback.index=latest ? Math.max(0,d.timeline.length-1) : Math.max(0,d.timeline.findLastIndex(x=>x.ts<=d.requestedAt));
    renderReplay(d);
    return true;
  }catch(e){if(request===playback.request)$('replay-status').textContent=e.message;return false;}
}
function selectReplayFrame(index) {
  const position=Math.max(0,Math.min(playback.timeline.length-1,index));
  const time=playback.timeline[position]?.ts;
  if(!Number.isFinite(time))return Promise.resolve(false);
  return loadReplay(time);
}
async function advanceReplay() {
  if(!playback.playing)return;
  if(!await selectReplayFrame(playback.index+1)||playback.index>=playback.timeline.length-1){pauseReplay();return;}
  if(playback.playing)playback.timer=setTimeout(advanceReplay,700);
}
$('replay-sessions').onchange=event=>chooseReplay(event.target.value);
$('replay-cursor').oninput=event=>{pauseReplay();void selectReplayFrame(Number(event.target.value));};
$('replay-prev').onclick=()=>{pauseReplay();void selectReplayFrame(playback.index-1);};
$('replay-next').onclick=()=>{pauseReplay();void selectReplayFrame(playback.index+1);};
$('replay-play').onclick=async()=>{
  if(playback.playing){pauseReplay();return;}
  playback.playing=true;replayButtons();
  if(playback.index>=playback.timeline.length-1&&!await selectReplayFrame(0)){pauseReplay();return;}
  if(playback.playing)playback.timer=setTimeout(advanceReplay,700);
};
$('replay-form').onsubmit=async event=>{
  event.preventDefault();$('replay-start').disabled=true;
  $('replay-status').textContent='正在启动本机录制…';
  try{
    const {session}=await api('replay/start',{venue:$('replay-venue').value,symbol:$('replay-symbol').value.trim().toUpperCase()});
    await replayList(session.id);
  }catch(e){$('replay-status').textContent=e.message;$('replay-start').disabled=Boolean(playback.activeId);}
};
$('replay-stop').onclick=async()=>{
  if(!playback.activeId)return;
  const id=playback.activeId;
  $('replay-stop').disabled=true;
  try{await api('replay/stop',{id});await replayList(id);await loadReplay(null,true);}
  catch(e){$('replay-status').textContent=e.message;$('replay-stop').disabled=false;}
};
$('replay-import').onchange=async event=>{
  const [file]=event.target.files;
  if(!file)return;
  try{
    if(file.size>16*1024*1024)throw new Error('复盘文件超过 16 MB。');
    const {session}=await api('replay/import',{text:await file.text()});
    await replayList(session.id);
  }catch(e){$('replay-status').textContent=e.message;}
  finally{event.target.value='';}
};
$('replay-export').onclick=async()=>{
  if(!playback.id||!playback.details)return;
  try{
    const {text}=await api('replay/export?'+new URLSearchParams({id:playback.id}));
    const url=URL.createObjectURL(new Blob([text],{type:'application/x-ndjson'}));
    const a=el('a');a.href=url;a.download='tide-lens-'+playback.details.session.venue+'-'+playback.details.session.symbol+'.ndjson';
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){$('replay-status').textContent=e.message;}
};
setInterval(()=>{
  if(!$('replay').hidden&&playback.activeId&&playback.id===playback.activeId&&!playback.playing){
    const latest=playback.index>=playback.timeline.length-1;
    const time=playback.timeline[playback.index]?.ts;
    void loadReplay(latest?null:time,latest);
  }
},5000);
const calcLabels={quantity:'币数量',notional:'仓位名义价值',initialMargin:'初始保证金',liquidationPrice:'估算强平价',pnl:'毛盈亏',fees:'手续费',netPnl:'净盈亏',roePct:'保证金收益率 %',fundingPayment:'资金费现金流',riskQuantity:'风险仓位数量',riskNotional:'风险仓位名义价值',riskMargin:'所需保证金',rewardRisk:'盈亏比'};
async function runCalc() {
  const input=Object.fromEntries([...new FormData($('calc-form'))].filter(([,v])=>v!=='').map(([k,v])=>[k,k==='side'?v:Number(v)]));
  try{
    const result=await api('calculate',input);
    const out=el('div',null,'calc-output');
    for(const [key,label] of Object.entries(calcLabels)) {
      const line=el('div');
      line.append(el('span',label),el('strong',num(result[key])));
      out.append(line);
    }
    $('calc-results').replaceChildren(out,button('查看计算假设',()=>showEvidence('逐仓计算器',{label:'线性永续估算',method:result.assumptions.join('。'),quality:'estimated'},null,input,null,'estimated'),'source-link'));
  }catch(e){empty($('calc-results'),e.message,true);}
}
$('calc-form').addEventListener('submit',event=>{event.preventDefault();void runCalc();});
async function loadReviews() {
  try{
    const {reviews}=await api('reviews');
    state.reviews=new Map(reviews.map(r=>[r.fact.id,r]));
    table($('review-list'),['数据','市场','时间','质量','状态'],reviews.map(({fact,decision})=>[
      button(fact.label,()=>showEvidence(fact.label,fact.source,null,fact.context,fact),'source-link'),
      venueName[fact.venue]+' '+fact.symbol,when(fact.asOf),badge(fact.quality),
      {approved:'已确认',rejected:'已拒绝',revoked:'已撤回'}[decision],
    ]),'还没有核对记录。');
  }catch(e){empty($('review-list'),e.message,true);}
}
$('analysis').onclick=async()=>{
  try{
    const analysis=await api('analysis'), detail=el('div',null,'panel');
    detail.append(el('p',analysis.summary));
    const results=el('div');
    if(analysis.count) {
      table(results,['证据','市场','时间','值'],analysis.evidence.map(f=>[
        f.label,venueName[f.venue]+' '+f.symbol,when(f.asOf),num(f.value)+' '+f.unit,
      ]));detail.append(results);
    }
    $('analysis-results').replaceChildren(detail);
  }catch(e){empty($('analysis-results'),e.message,true);}
};
const marketWatch=setupMarketWatch({$,api,el,button,table,empty,badge,showEvidence,link,num,changeClass});
const resize = new ResizeObserver(()=>{drawCharts();drawWhale();});
resize.observe($('price-chart').parentElement);
resize.observe($('whale-chart').parentElement);
setInterval(()=>{if(!$('scan').hidden&&!document.hidden)void loadScanner();},60_000);
void loadMarket();
void runCalc();
