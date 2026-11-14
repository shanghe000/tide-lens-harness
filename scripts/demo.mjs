import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startDashboard} from '../server.mjs';

const end=Date.UTC(2026,9,15,8);
const step=5*60_000;
const label='Tide Lens 合成演示数据';
const source={label,method:'用于演示界面的合成序列，由确定性公式生成。',quality:'estimated'};
const candles=Array.from({length:288},(_,i)=>{
  const baseline=62_400+i*13-7_500/(1+Math.exp(-(i-159)/7))+850*Math.sin(i/23);
  const open=baseline+85*Math.sin(i*1.65);
  const close=baseline+89*Math.sin((i+1)*1.65)+75*Math.cos(i*.62);
  return {ts:end-(288-i)*step,open,close,high:Math.max(open,close)+31+(i%7)*8,
    low:Math.min(open,close)-45-(i%6)*10,volume:42+i%41,confirmed:true};
});
const price=candles.at(-1).close;
const oi=candles.filter((_,i)=>i%3===0).map((c,i)=>{
  const value=20_300+i*53+900*Math.sin(i/9)+(i>52?3800:0);
  return {ts:c.ts+step,value};
});
const level=(direction,i)=>{
  const p=Math.round(price)+direction*(12+i*22);
  const size=1.5+((i*7+direction+14)%15)/2;
  return {price:p,size,notional:p*size};
};
const metrics={price,change:-4.74,oi:oi.at(-1).value,oiUsd:oi.at(-1).value*price,funding:.000067,longRatio:1.67};
const market={
  demo:true,venue:'okx',symbol:'BTC',window:'24h',asOf:end,metrics,candles,
  series:{oi,oiUsd:oi.map(p=>({...p,value:p.value*price})),funding:[{ts:end-4*3_600_000,value:.000025},{ts:end-step,value:.000067}],
    longRatio:oi.map((p,i)=>({...p,value:1.5+.20*Math.sin(i/6)}))},
  trades:Array.from({length:20},(_,i)=>({ts:end-step+500+i*11_000,price,size:.4+i/20,notional:price*(.4+i/20),side:i%3?'sell':'buy',id:'example-'+i})),
  book:{ts:end-213,bids:Array.from({length:10},(_,i)=>level(-1,i)),asks:Array.from({length:10},(_,i)=>level(1,i))},
  liquidations:[],sources:Object.fromEntries([...Object.keys(metrics),'candles','book','trades','oiHistory'].map(key=>[key,source])),
  errors:{liquidations:'演示快照没有公开强平样本。'},
};
const demoSource={label:'合成市场观察演示',method:'这些记录由代码生成，只用于展示筛选与证据界面。',quality:'estimated'};
const quote=(id,label,category,venue,mark,change,volume,funding,extra={})=>{
  const openInterest=Math.round(volume/mark/3);
  const values={markPrice:mark,oraclePrice:mark*.999,changePct24h:change,volumeUsd:volume,openInterest,
    openInterestUsd:openInterest*mark,fundingRatePct:funding,...extra};
  return {id,symbol:id.split(':').at(-1),venue,category,label,status:'trading',asOf:end,source:demoSource,...values,
    fieldSources:Object.fromEntries(Object.keys(values).map(key=>[key,demoSource])),raw:{demo:true,...values}};
};
const demoTradfi={demo:true,venue:'multi',loadedAt:end,coverage:{status:'available',venues:[
  {venue:'binance',status:'available',label:'合成示例'},{venue:'hyperliquid',status:'available',label:'合成示例'}]},
  rows:[
    quote('binance:XAUUSDT','Gold','commodity','binance',2867.56,-1.28,67_584_203,.0048),
    quote('binance:NVDAUSDT','Nvidia','equity','binance',176.28,2.64,41_204_375,.0061),
    quote('xyz:CL','WTI Crude','commodity','hyperliquid',73.78,-.42,29_114_320,-.0052),
    quote('xyz:NDX','Nasdaq 100','index','hyperliquid',22_801.67,1.08,11_220_410,.0034),
    quote('binance:TSLAUSDT','Tesla','equity','binance',314.62,-2.89,8_316_940,.0081),
    quote('xyz:EUR','EUR / USD','fx','hyperliquid',1.0814,.18,5_670_140,.0011),
    quote('xyz:SILVER','Silver','commodity','hyperliquid',36.47,-.82,4_671_200,-.0044),
    quote('binance:METAUSDT','Meta','equity','binance',558.24,1.57,3_339_197,.0025),
    quote('binance:ORIONUSDT','Orion Labs','pre-ipo','binance',175.81,3.41,12_701_550,.005),
    quote('io:ATLAS','Atlas Systems','pre-ipo','hyperliquid',156.4,-1.61,2_301_990,.0021,
      {impliedValuationUsd:156_400_000_000}),
    quote('binance:AURORAUSDT','Aurora Robotics','pre-ipo','binance',56.11,1.77,2_095_469,.006),
  ],
};
const demoDelistings={demo:true,asOf:end,rows:[
  {id:'example-a',venue:'binance',symbol:'SOLAR/USDT',title:'合成演示 · SOLAR 现货交易对终止',marketType:'spot',stage:'upcoming',
    effectiveAt:Date.UTC(2030,9,19,10),publishedAt:end-step,source:demoSource,raw:{example:true}},
  {id:'example-b',venue:'okx',symbol:'TERRA-USD-SWAP',title:'合成演示 · TERRA 永续合约终止',marketType:'perpetual',stage:'recent',
    effectiveAt:end-step*200,publishedAt:end-step*400,source:demoSource,raw:{example:true}},
  {id:'example-c',venue:'bybit',symbol:'RIVERUSDT',title:'合成演示 · RIVER 衍生品公告',marketType:'derivatives',stage:'notice',
    effectiveAt:null,publishedAt:end-step*15,source:demoSource,raw:{example:true}},
],sources:{}};
const dashboard=await startDashboard({marketLoader:async({venue,symbol,window})=>({...market,venue,symbol,window}),
  screenerLoader:async({venue})=>({venue,asOf:end,rows:[],errors:{},sources:{}}),
  whaleLoader:async()=>({timestamp:end,positions:[],source:demoSource,summary:{accountValue:null,totalNotional:null}}),
  whaleHistoryLoader:async()=>({start:end-24*3_600_000,end,positions:[],events:[],funding:{events:[],coverage:{status:'missing'}},
    source:demoSource,coverage:{status:'missing',reason:'合成演示不查询外部地址。'}}),
  tradfiLoader:async()=>demoTradfi,
  delistingsLoader:async({venue})=>({...demoDelistings,rows:demoDelistings.rows.filter(row=>venue==='all'||row.venue===venue)}),
  replayMarketLoader:async()=>({book:null,liquidations:[],errors:{book:'演示环境没有外部盘口信号。'}}),
  dataDirectory:process.env.TIDE_LENS_REVIEW_DIR || await mkdtemp(join(tmpdir(),'tide-lens-demo-')),
});
console.log(dashboard.url);
