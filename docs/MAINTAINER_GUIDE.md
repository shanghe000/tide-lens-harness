# Tide Lens 维护说明

提交前运行 `npm test`、`python3 -m unittest discover -s tests` 和 `python3 scripts/check_publication.py`。用干净的 Harness Web profile 安装 `npm pack` 生成的制品，核验左侧菜单、行情、核对记录和分析工具。

版本发布采用与 `package.json` 一致的标签。将安装包与 SHA-256 校验值上传到 GitHub Release。行情来源与模型假设变更应同步更新 [覆盖表](coverage.md)。访问密钥、用户核对记录和交易所原始快照保存在使用者自己的环境中。
