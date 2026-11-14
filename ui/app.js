import { evaluateAlerts } from './advanced.mjs';

const $ = id => document.getElementById(id);
const state = {
  market: null, screener: null, window: '24h', series: 'oiUsd', cursor: 0, venue: 'okx',
  request: 0, scanRequest: 0, reviews: new Map(),
};
const venueName = {okx:'OKX',binance:'Binance',bybit:'Bybit'};
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
const prefs = {watchlist: [], rules: [], events: []};
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
    $('evidence-body').prepend(el('p',label),el('p',isMetric ? fmt(type,fact.value) : num(fact.value) + ' ' + fact.unit));
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
  return {g,x,y,top,bottom,left,right};
}
function vertical(base, ts) {
  if (!base || !Number.isFinite(ts)) return;
  const {g,x,top,bottom} = base;
  g.strokeStyle = '#85e9db';
  g.setLineDash([4,4]);g.beginPath();g.moveTo(x(ts),top);g.lineTo(x(ts),bottom);g.stroke();g.setLineDash([]);
}
function currentCandle() { return state.market?.candles[state.cursor]; }
function drawCharts() {
  const m = state.market;
  if (!m || $('market').hidden) return;
  const candles = m.candles;
  const times = candles.map(p=>p.ts), point = currentCandle();
  const price = drawBase($('price-chart'),Math.min(...candles.map(c=>c.low)),Math.max(...candles.map(c=>c.high)),times,'K 线暂缺');
  if (price) {
    const {g,x,y,left,right} = price;
    const width = Math.max(1, Math.min(11, (right-left)/Math.max(candles.length,1)*.72));
    candles.forEach(c=>{
      g.strokeStyle=g.fillStyle=c.close>=c.open?'#58dfb4':'#ff9099';
      g.beginPath();g.moveTo(x(c.ts),y(c.high));g.lineTo(x(c.ts),y(c.low));g.stroke();
      g.fillRect(x(c.ts)-width/2,Math.min(y(c.open),y(c.close)),width,Math.max(1,Math.abs(y(c.open)-y(c.close))));
    });
    vertical(price,point?.ts);
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
    state.market=m;state.venue=venue;state.cursor=m.candles.length-1;
    const available=Object.values(m.metrics).some(Number.isFinite) || m.candles.length>0;
    $('live-status').textContent=available?venueName[venue]+' · '+when(m.asOf)+' UTC+8':'行情源暂不可用';
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
    const candles=state.market?.candles||[];
    if(!candles.length)return;
    const rect=chart.getBoundingClientRect();
    const fraction=Math.max(0,Math.min(1,(event.clientX-rect.left-10)/Math.max(rect.width-80,1)));
    const cursor=Math.round(fraction*(candles.length-1));
    if(cursor!==state.cursor)updateCursor(cursor);
  });
  chart.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
    event.preventDefault();updateCursor(state.cursor+(event.key==='ArrowLeft'?-1:1));
  });
}
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
$('whale-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const parent=$('whale-results'),btn=event.submitter;
  btn.disabled=true;empty(parent,'正在读取 Hyperliquid 公开持仓…');
  try{
    const result=await api('whale?'+new URLSearchParams({address:$('whale-address').value.trim()}));
    const summary=el('p','账户价值 '+num(result.summary.accountValue,true)+' USD · 名义持仓 '+num(result.summary.totalNotional,true)+' USD · '+when(result.timestamp)+' UTC+8');
    const details=el('div');
    table(details,['币种','方向','数量','平均入场','强平价','未实现盈亏'],result.positions.map(r=>[
      r.symbol,r.side==='long'?'多':'空',num(r.quantity),num(r.entryPrice),num(r.liquidationPrice),num(r.unrealizedPnl),
    ]),'此地址没有公开的永续仓位。');
    parent.replaceChildren(summary,details,button('账户来源',()=>showEvidence('Hyperliquid 公开地址',result.source,null,result,null,'measured'),'source-link'));
  }catch(e){empty(parent,e.message,true);}
  finally{btn.disabled=false;}
});
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
const resize = new ResizeObserver(drawCharts);
resize.observe($('price-chart').parentElement);
setInterval(()=>{if(!$('scan').hidden&&!document.hidden)void loadScanner();},60_000);
void loadMarket();
void runCalc();
