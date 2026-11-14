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
const dashboard=await startDashboard({marketLoader:async({venue,symbol,window})=>({...market,venue,symbol,window}),
  screenerLoader:async({venue})=>({venue,asOf:end,rows:[],errors:{},sources:{}}),
  replayMarketLoader:async()=>({book:null,liquidations:[],errors:{book:'演示环境没有外部盘口信号。'}}),
  dataDirectory:process.env.TIDE_LENS_REVIEW_DIR || await mkdtemp(join(tmpdir(),'tide-lens-demo-')),
});
console.log(dashboard.url);
