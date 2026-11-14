# Tide Lens · 行情透镜

Tide Lens 是面向 DeepSeek Harness Web 的永续合约研究看板。它将价格、持仓、账户多空比、资金费率及可用的成交样本放到同一时间轴，并保留交易所和计算口径。点击关键数字核对后，可在 Harness 对话中请模型分析已确认数据。

## 安装

需要 Node.js 24.9 以上、DeepSeek Harness Web 0.2.2-rc.1 和 pnpm。下载 GitHub Releases 的 `dsh-tide-lens-0.1.0.tgz`，在该目录执行：

```sh
npx @deepseek-ai/dsh@0.2.2-rc.1 plugin --profile web add ./dsh-tide-lens-0.1.0.tgz
npx @deepseek-ai/dsh@0.2.2-rc.1 web
```

浏览器里的 Harness 左侧菜单选择 **Tide Lens**。看板连接宿主机的回环地址，浏览器和 Harness 需要在同一台机器。已有其他 profile 时可先运行 `dsh plugin --profile web list` 检查。需要移除时运行 `dsh plugin --profile web remove dsh-tide-lens`。

## 用法

1. 选择 OKX、Binance 或 Bybit 和币种，查询对应 USDT 本位永续。用同一条时间轴查看 K 线、持仓及估算清算图。
2. 点击指标、时间点、盘口档位或公开成交查看来源。确认或拒绝具体观察值，行情刷新会产生新的快照。
3. 打开「核对记录」查看证据或撤回确认。在 Harness 对话中可输入「用 Tide Lens 已确认的数据，列出来源和时间，再分析价格变化与持仓变化的关系」。
4. 异动页支持涨跌、成交额、持仓和费率排名、手动关注和网页打开时的本地阈值提示。地址观察接受用户输入的 Hyperliquid 公开地址。计算器支持逐仓强平、收益、费用、资金费及风险仓位估算。

## 范围与口径

- 附带的数据文件为空。运行时从用户所在机器向交易所发起公开请求。交易所的网络可用性和使用条件适用于这些请求，可使用常规 `HTTPS_PROXY`、`HTTP_PROXY` 和 `NO_PROXY` 环境配置。
- 盘口显示当前公开快照，不能重建旧盘口。成交是公开逐笔接口返回的有限样本，分档是按每笔的名义价值，无法据此识别账户大小。账户多空比按交易所给出的比例字段展示，绝对账户数缺失。公开强平成交的覆盖按交易所和时间而异，缺失数据保留缺失状态。
- 清算热力图是基于公开持仓变化和杠杆假设的独立模型。颜色是归一化强度。详情中列明模型输入、杠杆和维持保证金率。
- 地址观察不提供识别巨鲸身份、完整群体账户历史或交易执行。站外可见功能和实现范围见 [覆盖追踪表](docs/coverage.md)。
- 核对记录保存在 `~/.tide-lens/`。通过 `TIDE_LENS_REVIEW_DIR` 可指定本机保存目录。发布仓库和安装包无交易所密钥、用户记录或第三方数据快照。数据提供者保留其各自权利。
- 独立的只读研究工具，模型输出和计算器估算都需要自行核对。

## 开发

```sh
npm test
npm start
npm pack
```

`npm start` 打印可在本机浏览器中打开的临时地址。插件没有额外的运行依赖，Harness 在挂载时提供工具开发接口。独立代码采用 [MIT 许可](LICENSE)。
