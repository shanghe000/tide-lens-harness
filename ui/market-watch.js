const categories = {equity:'股票与 ETF',index:'指数',commodity:'商品',fx:'外汇',rates:'利率','pre-ipo':'上市前'};
const venues = {binance:'Binance',hyperliquid:'Hyperliquid',okx:'OKX',bybit:'Bybit'};
const stages = {upcoming:'待生效',recent:'已生效',notice:'时间待核实'};
const markets = {spot:'现货',perpetual:'永续',futures:'期货',derivatives:'衍生品',margin:'杠杆',other:'其他产品',unknown:'待核实'};
const fields = {
  markPrice:'标记价',oraclePrice:'参考价',changePct24h:'24h 变动',volumeUsd:'24h 成交额',
  openInterest:'未平仓量',openInterestUsd:'名义持仓',fundingRatePct:'资金费率',longRatio:'账户多空比',
  impliedValuationUsd:'隐含估值',
};
const formatTime = new Intl.DateTimeFormat('zh-CN',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const time = value => typeof value === 'number' ? value : Date.parse(value);
const utc = value => Number.isFinite(time(value)) ? formatTime.format(time(value))+' UTC' : '—';
const availability = {available:'可用',partial:'部分可用',missing:'缺失',ok:'可用',empty:'范围内无事件',unavailable:'暂不可读',error:'缺失'};
const visibleCap = 80;

export function setupMarketWatch({ $, api, el, button, table, empty, badge, showEvidence, link, num, changeClass }) {
  const views = new Map();
  function makeSelect(container, label, id, choices) {
    const node=el('select');node.id=id;
    node.append(...choices.map(([key,text])=>new Option(text,key)));
    const wrapper=el('label',label);wrapper.append(node);container.append(wrapper);
    return node;
  }
  function status(view,message,error=false) {
    view.status.replaceChildren(el('span',message,error?'error':undefined));
  }
  function noticeTime(value,now=Date.now()) {
    const ms=time(value);
    if(!Number.isFinite(ms))return '起止时间待核实';
    if(ms<=now)return '生效时间已过';
    const minutes=Math.ceil((ms-now)/60000);
    const days=Math.floor(minutes/1440),hours=Math.floor(minutes%1440/60);
    return '还有 '+[days&&days+' 天',hours&&hours+' 时',minutes%60+' 分'].filter(Boolean).join(' ');
  }
  function displayNumber(key,value) {
    if(!Number.isFinite(value))return '—';
    const ending=key.endsWith('Pct')||key==='changePct24h'?'%':key==='longRatio'?' 倍':'';
    return num(value,key.endsWith('Usd'))+ending;
  }
  function quoteSource(row,key) {
    return row.fieldSources?.[key] ?? {label:'所选合约',quality:'missing',method:'数据源没有提供该字段或当前范围未查询。'};
  }
  function quoteButton(row,key,value=row[key]) {
    const b=button(displayNumber(key,value),()=>{
      const source=quoteSource(row,key);
      showEvidence(fields[key],source,Number.isFinite(value)?null:'这次查询没有可用值。',
        {contract:row.id,quoteCurrency:row.quoteCurrency ?? row.quoteAsset,asOf:row.observedAt ?? row.retrievedAt ?? row.asOf,
          field:key,value,raw:source.raw ?? row.raw,basis:key==='impliedValuationUsd'?row.impliedValuationBasis:undefined},
        row.audit?.[key],source.quality);
    },'source-link '+(['changePct24h','fundingRatePct'].includes(key)?changeClass(value):''));
    b.setAttribute('aria-label',row.symbol+' '+fields[key]+' '+displayNumber(key,value));
    return b;
  }
  function addLine(list,label,value) {
    const dt=el('dt',label),dd=el('dd');
    if(value instanceof Node)dd.append(value);else dd.textContent=value ?? '—';
    list.append(dt,dd);
  }
  function quoteDetail(view,row) {
    if(!row){view.detail.replaceChildren(el('h2','合约详情'),el('p','没有匹配的合约。'));return;}
    const h=el('h2',row.label||row.symbol);
    const stamp=el('p',[venues[row.venue]||row.venue,row.dex,row.symbol,categories[row.category]].filter(Boolean).join(' · '),'market-subtitle');
    const list=el('dl');
    for(const key of ['markPrice','oraclePrice','changePct24h','volumeUsd','openInterest','openInterestUsd','fundingRatePct','longRatio']){
      if(key==='longRatio'&&!Object.hasOwn(row,key))continue;
      const unit=['markPrice','oraclePrice'].includes(key)?row.quoteCurrency:['volumeUsd','openInterestUsd'].includes(key)?row.notionalCurrency:null;
      addLine(list,fields[key]+(unit?' · '+unit:''),quoteButton(row,key));
    }
    if(view.id==='preipo'){
      addLine(list,'隐含估值 USD 等值',quoteButton(row,'impliedValuationUsd'));
      if(!Number.isFinite(row.impliedValuationUsd))list.append(el('p','换算条款缺失，当前仅显示合约报价。'));
    }
    const source=row.classificationSource ?? row.source?.classification ?? row.source;
    const explore=button('合约分类及原始字段',()=>{
      const entry=typeof source==='string'?{url:source}:source;
      showEvidence('合约分类与报价',
        {...entry,label:entry?.label||venues[row.venue],method:entry?.method||row.method||
          '分类使用交易场所的公开合约元数据。永续合约报价和标的资产的市场价格分别计量。'},
        null,{symbol:row.symbol,id:row.id,category:row.category,status:row.status,raw:row.raw},null,'measured');
    },'source-link');
    view.detail.replaceChildren(h,stamp,list,explore);
    if(row.quoteBasis&&view.id==='preipo')view.detail.append(el('p',({'company-valuation':'报价按公司估值刻度显示。','share-price':'报价按合约参考股价刻度显示。',unspecified:'交易所未明确公布股票或公司估值换算基准。'})[row.quoteBasis] || row.quoteBasis));
    if(row.termsUrl){const terms=link(row.termsUrl,'查看合约条款');if(terms)view.detail.append(el('br'),terms);}
    if(row.status&&row.status!=='trading')view.detail.append(el('p','交易状态 '+row.status));
  }
  function eventDetail(view,row) {
    if(!row){view.detail.replaceChildren(el('h2','事件详情'),el('p','没有匹配的事件。'));return;}
    const list=el('dl'),kind=markets[row.marketType ?? row.market] || '待核实';
    addLine(list,'交易所与市场',[venues[row.venue],kind].filter(Boolean).join(' · '));
    addLine(list,'公告时间',utc(row.publishedAt));
    addLine(list,'生效时间',button(utc(row.effectiveAt),()=>eventEvidence(row),'source-link'));
    if(row.stage==='upcoming')addLine(list,'距生效时间',noticeTime(row.effectiveAt));
    const official=link(row.url,'打开官方公告');
    view.detail.replaceChildren(el('h2','事件详情'),el('p',row.title||row.symbol),list,
      button('核对时间与原始字段',()=>eventEvidence(row),'source-link'));
    if(official)view.detail.append(official);
  }
  function eventEvidence(row) {
    const source=row.source ?? {};
    const effective=time(row.effectiveAt);
    const method=[source.method,row.stage==='upcoming'?'倒计时为生效时间减去本机当前时间，按分钟向上取整。':null].filter(Boolean).join(' ');
    showEvidence('退市事件 · '+(row.symbol||row.symbols?.join(' / ')||venues[row.venue]),
      {...source,documentation:source.documentation||source.docs,method},
      Number.isFinite(effective)?null:'公开资料缺少可确认的生效时间。公告发布时间单独展示。',
      {title:row.title,market:row.marketType ?? row.market,stage:row.stage,publishedAt:row.publishedAt,
        effectiveAt:row.effectiveAt,observedAt:row.observedAt,raw:row.raw},
      row.fact?{...row.fact,source:{...row.fact.source,method}}:null,
      Number.isFinite(effective)?source.quality:'missing');
  }
  function coverageDetail(view) {
    const data=view.data;
    if(!data)return;
    const groups=data.coverage?.venues ?? Object.entries(data.sources??{}).flatMap(([venue,entry])=>
      (Array.isArray(entry)?entry:[entry]).filter(Boolean).map(source=>({...source,venue})));
    showEvidence('来源覆盖',{label:view.id==='delistings'?'交易所公告与合约元数据':'合约详情与分类元数据',
      method:view.id==='delistings'?'到期日、公告发布时间和退市生效时间使用不同字段。倒计时按生效时间减去本机当前时间。':'按交易所归类区分 TradFi 和 Pre-IPO。字段及换算公式见每个数字的证据。'},
      data.coverage?.reason,{at:data.loadedAt??data.asOf,coverage:groups,notes:data.coverage?.notes,errors:data.errors},null,
      data.demo?'estimated':groups.some(g=>['available','ok','empty','partial'].includes(g.status))?'measured':'missing');
    for(const group of groups){
      const a=link(group.url??group.link??group.docs??group.documentation,[venues[group.venue],group.label].filter(Boolean).join(' · '));
      const line=el('p',[(availability[group.status]||group.status),group.reason ?? group.detail].filter(Boolean).join(' · '),'source-item');
      if(a)line.prepend(a,' · ');
      if(line.textContent)$('evidence-body').append(line);
    }
  }
  function equalVenue(view,row) {
    return view.venue.value==='all'||view.venue.value===row.venue;
  }
  function render(view) {
    const data=view.data;
    if(!data)return;
    const text=view.filter.value.trim().toLowerCase();
    const events=view.id==='delistings';
    const rows=data.rows.filter(row=>equalVenue(view,row)&&
      (events?(view.kind.value==='all'||view.kind.value===row.stage)&&(view.market.value==='all'||view.market.value===(row.marketType ?? row.market)):
        (view.id==='preipo'?row.category==='pre-ipo':row.category!=='pre-ipo'&&(view.kind.value==='all'||view.kind.value===row.category)))&&
      (!text||[row.title,row.label,row.symbol,row.id,...(row.symbols??[])].some(v=>String(v??'').toLowerCase().includes(text))));
    if(!events) {
      const key=view.sort.value;
      rows.sort((a,b)=>Number.isFinite(a[key])&&Number.isFinite(b[key])?b[key]-a[key]:
        Number.isFinite(a[key])?-1:Number.isFinite(b[key])?1:a.symbol.localeCompare(b.symbol));
    }
    const selection=rows.find(r=>r.id===view.selected)??rows[0];
    view.selected=selection?.id;
    const summary=typeof data.coverage?.status==='string'?availability[data.coverage.status]:null;
    const coverage=events?Object.entries(data.sources??{}).flatMap(([venue,s])=>
      (Array.isArray(s)?s:[s]).map(x=>({venue,...x}))):data.coverage?.venues??[];
    const unavailable=coverage.filter(x=>!['available','ok','complete','empty'].includes(x.status));
    status(view,[data.demo?'合成演示':utc(data.loadedAt??data.asOf),rows.length+' 条',
      rows.length>visibleCap?'显示前 '+visibleCap+' 条':null,summary&&summary!=='可用'?summary:null,
      unavailable.length?'部分来源或字段缺失，点开来源覆盖查看':null].filter(Boolean).join(' · '));
    const select=row=>{
      view.selected=row.id;
      for(const b of view.root.querySelectorAll('[data-watch-row]'))b.setAttribute('aria-pressed',b.dataset.watchRow===row.id);
      (events?eventDetail:quoteDetail)(view,row);
    };
    const labelFor=row=>{
      const title=events?(row.symbols?.filter(Boolean).join(' / ')||row.symbol||row.title):(row.label||row.symbol);
      const cell=el('div',null,'watch-market-cell');
      const b=button(title,()=>select(row),'pair-button watch-event-title');
      b.dataset.watchRow=row.id;b.setAttribute('aria-pressed',row.id===view.selected);b.title=title;
      cell.append(b,el('div',events?row.title:row.symbol,'market-subtitle'));
      return cell;
    };
    if(events){
      table(view.list,['标的 / 公告','交易所','市场','状态','生效 UTC','查看'],rows.slice(0,visibleCap).map(row=>[
        labelFor(row),venues[row.venue]||row.venue,markets[row.marketType??row.market]||'待核实',
        el('span',stages[row.stage]||row.stage,'tag '+row.stage),button(utc(row.effectiveAt),()=>eventEvidence(row),'source-link'),
        button(row.stage==='upcoming'?noticeTime(row.effectiveAt):'核对来源',()=>eventEvidence(row),'source-link'),
      ]),'当前筛选没有事件。数据覆盖见「来源覆盖」。');
    }else{
      const keys=view.id==='preipo'?['markPrice','changePct24h','volumeUsd','openInterestUsd','fundingRatePct','longRatio','impliedValuationUsd']:
        ['markPrice','changePct24h','volumeUsd','openInterestUsd','fundingRatePct'];
      table(view.list,['合约','交易所',...keys.map(k=>fields[k])],rows.slice(0,visibleCap).map(row=>[
        labelFor(row),[venues[row.venue],row.dex].filter(Boolean).join(' · '),...keys.map(key=>quoteButton(row,key)),
      ]),'当前筛选没有合约。数据覆盖见「来源覆盖」。');
    }
    (events?eventDetail:quoteDetail)(view,selection);
  }
  async function refresh(view,quiet=false) {
    const request=++view.request;
    if(!quiet) status(view,view.id==='delistings'?'正在读取交易所公告…':'正在查询公开合约…');
    view.refresh.disabled=true;
    try{
      const events=view.id==='delistings';
      const params=new URLSearchParams({venue:view.venue.value});
      if(events)params.set('window',view.window.value);
      const data=await api((events?'delistings':'tradfi')+'?'+params);
      if(request!==view.request)return;
      view.data=data;view.updated=Date.now();render(view);
    }catch(error){
      if(request===view.request)status(view,view.data?'刷新失败 · '+error.message+' · 仍显示前次数据':error.message,true);
    }finally{if(request===view.request)view.refresh.disabled=false;}
  }
  for(const id of ['tradfi','preipo','delistings']){
    const events=id==='delistings', host=$(id+'-toolbar'),view={id,root:$(id),status:$(id+'-status'),
      list:$(id+'-table'),detail:$(id+'-detail'),refresh:$(id+'-refresh'),request:0,updated:0,data:null};
    const options=events?['binance','okx','bybit']:['binance','hyperliquid'];
    view.venue=makeSelect(host,'交易所',id+'-venue',[['all','全部'],...options.map(v=>[v,venues[v]])]);
    if(events){
      view.kind=makeSelect(host,'状态',id+'-kind',[['all','全部'],...Object.entries(stages)]);
      view.market=makeSelect(host,'市场',id+'-market',[['all','全部'],...Object.entries(markets)]);
      view.window=makeSelect(host,'已生效回看',id+'-window',[['30d','30 天'],['7d','7 天'],['90d','90 天']]);
      view.market.onchange=()=>render(view);view.window.onchange=()=>void refresh(view);
    }else{
      if(id==='tradfi')view.kind=makeSelect(host,'资产类别',id+'-kind',[['all','全部'],...Object.entries(categories).filter(([k])=>k!=='pre-ipo')]);
      view.sort=makeSelect(host,'排名指标',id+'-sort',[['volumeUsd','成交额'],['openInterestUsd','名义持仓'],['changePct24h','24h 变动'],['fundingRatePct','资金费率']]);
      view.sort.onchange=()=>render(view);
    }
    view.filter=el('input');view.filter.type='search';view.filter.id=id+'-filter';view.filter.placeholder=events?'如 BTC、公告关键词':'如 Gold、NVDA';
    const search=el('label','搜索');search.append(view.filter);host.append(search);
    view.filter.oninput=()=>render(view);
    if(view.kind)view.kind.onchange=()=>render(view);
    view.venue.onchange=()=>void refresh(view);
    view.refresh.onclick=()=>void refresh(view);
    $(id+'-sources').onclick=()=>coverageDetail(view);
    views.set(id,view);
  }
  const onActivate=id=>{
    const view=views.get(id);
    if(view&&Date.now()-view.updated>60_000)void refresh(view);
  };
  setInterval(()=>{
    if(!document.hidden)for(const view of views.values()) if(!view.root.hidden&&!view.refresh.disabled)void refresh(view,true);
  },120_000);
  return {onActivate};
}
