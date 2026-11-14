# 功能与数据覆盖

对公开导航、页面描述、界面字段及已观察的交互做了功能对照。在干净浏览器中用 REA 核对公开入口的打开过程。公开页面提供了交互轮廓，未核实站点的后端逻辑、私有模型或登录后的权限范围。

| 公开功能 | Tide Lens 0.1 |
| --- | --- |
| 合约图表和持仓 | 多交易所 OHLC、同步时间轴、未平仓量和名义值。成交样本按单笔名义价值分档。图表集中在公开期货数据。 |
| 清算热力图、价位图与盘口 | 独立的持仓增量模型、分时热图、当前价位排行、独立的公开强平样本、当前多档盘口。 |
| 资金费率与多空比 | 资金费率、账户比率、历史图及实时截面，含可访问市场的排名。各交易所数据口径见原始来源。 |
| 异动、涨跌榜和关注 | 按公开指标排序过滤，关注列表与打开页面期间的阈值记录。 |
| 巨鲸 / 公开地址跟踪 | 用户输入地址的 Hyperliquid 公开持仓快照。站点的历史鲸鱼分组、平均开仓、排行信号和付费信号无对应实现。 |
| 合约计算器 | 逐仓保证金、收益、费用、资金费、估算强平和基于止损的仓位。 |
| AI 助理 | Harness 对话可读取用户核对后的证据。 |
| 绘图、TradFi / Pre-IPO、退市、网站付费与 Telegram、交易及钱包签名 | 尚无对应模块。 |

模型对正未平仓量变化分别按多空与杠杆情景分配，以已收盘 K 线近似入场。持仓下降时同比缩减存量，交易价穿越阈值时退出相应情景，时间断档时清除无法追踪的存量。输出强度无量纲。模型也会返回参与的 K 线和持仓数据来源。

参考功能入口见 [PumpGlass 公共首页](https://pumpglass.com/zh/) 与 [站点条款](https://pumpglass.com/terms)。运行时直接依赖 [OKX API](https://www.okx.com/docs-v5/)、[Binance USD-M](https://developers.binance.com/docs/derivatives/usds-margined-futures)、[Bybit V5](https://bybit-exchange.github.io/docs/v5/intro) 和 [Hyperliquid info](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)。站内数据、代码、品牌图及截图均未打包。
