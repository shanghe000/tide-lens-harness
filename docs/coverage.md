# 数据覆盖与计算说明

[English](coverage.en.md)

REA 用干净浏览器核对了 PumpGlass 的公开图表、巨鲸定位、清算/订单簿、TradFi、Pre-IPO 和退市页面。Tide Lens 自行实现研究流程，公开仓库只包含项目源码与合成演示。

| 模块 | 来源与方法 | 缺口 |
| --- | --- | --- |
| 净仓位历史 | Hyperliquid 主永续 `userFillsByTime` 的 `startPosition` 加上带正负号成交数量。买入为正，卖出为负。结束点使用 `clearinghouseState` 复核。同毫秒成交按仓位连续性排序。 | 仅输入的公开地址。超过交易所历史上限、排序歧义及断点均保留。期末官方快照与推算分别标注。 |
| 资金费流水 | Hyperliquid 的 `userFunding`。金额直接使用 `usdc`，费率乘以 100 显示为百分数。 | 独立显示资金费的限速、截断和缺失。 |
| 图表工具 | 锚点以 UTC 毫秒和 USDT 价格保存。价差是终点减起点，涨跌幅是价差除以起点乘以 100%，时长取两点时间差的绝对值。 | 绘图坐标取用户落点。当前时间窗口以外的标注视区域裁剪。 |
| 盘口回放 | 开启录制后约每 15 秒读取一次交易所盘口快照（请求耗时会延长间隔）。选中时间展示此前最近的快照，同时展示交易所时间和采样时间。名义价值为价格乘以基础币数量。 | 快照无法重建采样间的每笔挂撤单，缺帧和过时快照会标出。 |
| 公开强平回放 | OKX 读取近期公开样本，参考价为清算接管价。Binance 使用公开强平推送中已成交数量与平均成交价。Bybit 使用公开全量强平推送的数量与破产价。 | Binance 每合约每秒最多公开一条聚合快照。断线、未披露和记录开始前的数据均无法复原。参考价不一定等于实际成交价。 |
| 清算热力图 | 按公开持仓量增量和已收盘 K 线近似分配多空仓位，并应用杠杆和维持保证金假设。颜色为无量纲强度。 | 交易所账户级杠杆和实际清算金额缺失。 |
| TradFi 与 Pre-IPO | Binance USDⓈ-M 合约元数据、行情及资金费，Hyperliquid HIP-3 官方分类和合约快照。标记价与参考价分列；需计算时，24h 变动为（现价 ÷ 前一日参考价 − 1）×100，名义持仓为基础单位持仓 × 标记价。 | 仅显示可按来源分类的合约。Binance 单合约持仓查询有数量上限。合约报价和底层股票报价分开理解。 |
| Pre-IPO 隐含估值 | 对有公开合约条款的具体标的，用标记价乘以官方参考股数或估值倍率，单位为报价币折算的 USD 等值。 | 估值标为估算。换算基准缺失或变更时不补值，上市后按交易场所重分类。 |
| 退市监控 | Binance、Bybit、OKX 第一方公告及适用的公开合约计划。倒计时 = 已核实的 UTC 生效时间 − 本机当前时间。 | 公告发布时间和生效时间分开显示，来源、回看窗口与区域覆盖以接口为准。临时停牌及监控标签不纳入。 |
| 异动与筛选 | 合约公开行情，按市价、成交、费率及名义持仓排序。阈值在页面打开时检查。 | 持仓账户比只是比例。成交按逐笔名义值分档，无法识别账户大小。 |

历史记录仅由用户主动录制。导入文件可检查内容和来源声明，原始数据未经独立核验，因此不会进入已确认分析。

PumpGlass 的付费巨鲸信号、专有历史模型、钱包签名与下单与 Telegram 尚未覆盖。

[PumpGlass 条款](https://pumpglass.com/terms) · [Hyperliquid Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) · [OKX API](https://www.okx.com/docs-v5/) · [Binance 公开强平](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Liquidation-Order-Streams) · [Bybit 公开强平](https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation)

[Binance 合约元数据](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Exchange-Information) · [Hyperliquid 永续数据](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals) · [Binance 退市公告](https://www.binance.com/en/support/announcement/list/00000000000000000000000000161) · [Bybit 公告 API](https://bybit-exchange.github.io/docs/v5/announcement)
