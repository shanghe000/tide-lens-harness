# Data coverage and methods

[简体中文](coverage.md)

REA observed the publicly accessible PumpGlass chart, whale-positioning, and order-book/heatmap pages in a clean browser. Tide Lens implements its own research workflows. The repository ships project code and synthetic demo data.

| Module | Sources and calculations | Limits |
| --- | --- | --- |
| Wallet history | Hyperliquid main-perps `userFillsByTime` provides `startPosition`. Post-fill size equals starting size plus signed fill size, positive for buys and negative for sells. `clearinghouseState` supplies the endpoint checkpoint. | Only the supplied public address is queried. Retention caps, ambiguous ordering, and discontinuities remain visible. |
| Wallet funding | Hyperliquid `userFunding` supplies the `usdc` amount. The displayed percent is the fractional rate multiplied by 100. | Funding coverage and historical gaps are reported independently. |
| Chart tools | Anchors store UTC milliseconds and USDT prices. Measurement shows end minus start, percentage change from the start, and absolute elapsed time. | Plotted coordinates reflect manually placed anchors. Off-screen anchors are clipped against the current viewport. |
| Order book replay | Local recording samples the exchange REST book around every 15 seconds, plus response time. Replay selects the last sample at or before the chosen time. Notional equals price times base size. | Between-sample order changes cannot be reconstructed. Old snapshots and gaps are marked. |
| Liquidation replay | OKX contributes the latest published sample and takeover price. Binance contributes disclosed executed quantity and average execution price. Bybit contributes public all-liquidation size and bankruptcy price. | Binance publishes at most one snapshot per symbol per second. Disconnections, unpublished events, and pre-recording data are gaps. A bankruptcy or takeover price may differ from execution price. |
| Modeled liquidation map | Allocate positive open-interest changes across sides and leverage tiers using completed candles, then apply maintenance-margin assumptions. Color is a unitless intensity. | Account leverage and actual liquidation totals are unavailable. |
| Screeners | Exchange market snapshots feed sorting, watchlists, and thresholds while the page is open. | Account ratios are proportions. Trade sizes describe fills, with no inference about individual account sizes. |

Recordings start on demand. Imported data is available for inspection and stays outside the confirmed-evidence analysis queue.

Paid whale signals, PumpGlass historical models, wallet signing, trade execution, Telegram, TradFi, Pre-IPO, and delistings are outside the current release.

[PumpGlass Terms](https://pumpglass.com/terms) · [Hyperliquid Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) · [OKX API](https://www.okx.com/docs-v5/) · [Binance liquidation streams](https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Liquidation-Order-Streams) · [Bybit liquidation streams](https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation)
