const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info';
const HYPERLIQUID_PERPS_DOC = 'https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals';
const liquidationsDoc = 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/liquidations';
const magnitudeLimit = 1e15;

function optionalNumber(value, name, { min = 0, max = magnitudeLimit, exclusiveMin = false, integer = false } = {}) {
  if (value == null || (typeof value === 'string' && !value.trim())) return null;
  if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value))) {
    throw new Error(`${name}需要填写数值。`);
  }
  const n = Number(value);
  if (n < min || n > max || (exclusiveMin && n === min) || (integer && !Number.isInteger(n))) {
    throw new Error(`${name}超出可计算范围。`);
  }
  return n;
}

function requireNumber(value, name, limits) {
  const result = optionalNumber(value, name, limits);
  if (result == null) throw new Error(`请输入${name}。`);
  return result;
}

const positive = { exclusiveMin: true };

/** Model an isolated linear position with one maintenance margin tier. Rates are percentage inputs. */
export function calculate(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请提供计算参数。');
  const side = input.side === 'long' ? 1 : input.side === 'short' ? -1 : null;
  if (side == null) throw new Error('请选择做多或做空。');
  if (input.marginMode != null && input.marginMode !== 'isolated') throw new Error('当前估算适用于单一逐仓线性合约。');
  const entry = requireNumber(input.entryPrice, '开仓价', positive);
  const leverage = requireNumber(input.leverage, '杠杆', { min: 1, max: 1000 });
  const suppliedMargin = optionalNumber(input.margin, '逐仓保证金', positive);
  const suppliedSize = optionalNumber(input.quantity, '基础币数量', positive);
  if (suppliedMargin == null && suppliedSize == null) throw new Error('请输入逐仓保证金或基础币数量。');
  const quantity = suppliedSize ?? suppliedMargin * leverage / entry;
  const notional = quantity * entry;
  const initialMargin = notional / leverage;
  const margin = suppliedMargin ?? initialMargin;
  if (margin < initialMargin && (initialMargin - margin) > initialMargin * 1e-10) {
    throw new Error('输入保证金低于此仓位和杠杆所需的初始保证金。');
  }
  const maintenancePct = optionalNumber(input.maintenanceRatePct, '维持保证金率', { max: 99.999 });
  const deduction = optionalNumber(input.maintenanceDeduction, '维持保证金速算额') ?? 0;
  const feeRate = (optionalNumber(input.feeRatePct, '单边手续费率', { max: 100 }) ?? 0) / 100;
  const exit = optionalNumber(input.exitPrice, '平仓价', positive);
  const fundingPct = optionalNumber(input.fundingRatePct, '单期资金费率', { min: -100, max: 100 });
  const fundingPeriods = optionalNumber(input.fundingPeriods, '资金费结算期数', { max: 100_000, integer: true }) ?? 1;
  const fundingMark = optionalNumber(input.fundingMarkPrice, '资金费计价价', positive) ?? entry;
  let liquidationPrice = null;
  if (maintenancePct != null) {
    const rate = maintenancePct / 100;
    if (margin < Math.max(0, notional * rate - deduction)) throw new Error('开仓时的模拟保证金已低于输入的维持保证金。');
    const raw = (side * notional - margin - deduction) / (quantity * (side - rate));
    if (raw > 0) {
      const requirementAtPrice = raw * quantity * rate - deduction;
      const bankruptcy = entry - side * margin / quantity;
      liquidationPrice = requirementAtPrice >= 0 ? raw : bankruptcy > 0 ? bankruptcy : null;
    }
  }
  const pnl = exit == null ? null : side * (exit - entry) * quantity;
  const fees = exit == null ? null : quantity * (entry + exit) * feeRate;
  // Positive cash flow is received. A positive per-period rate is paid by longs.
  const fundingPayment = fundingPct == null ? null : -side * quantity * fundingMark * fundingPct / 100 * fundingPeriods;
  const netPnl = pnl == null ? null : pnl - fees + (fundingPayment ?? 0);
  const roePct = netPnl == null ? null : netPnl / margin * 100;
  const equity = optionalNumber(input.accountBalance, '账户余额', positive);
  const riskPct = optionalNumber(input.riskPct, '单笔风险比例', { exclusiveMin: true, max: 100 });
  const stop = optionalNumber(input.stopPrice, '止损价', positive);
  const target = optionalNumber(input.targetPrice, '止盈价', positive);
  if (stop != null && side * (entry - stop) <= 0) throw new Error('止损价应当在开仓价的不利方向。');
  if (target != null && side * (target - entry) <= 0) throw new Error('止盈价应当在开仓价的有利方向。');
  const riskBudget = equity == null || riskPct == null ? null : equity * riskPct / 100;
  const riskPerUnit = stop == null ? null : side * (entry - stop) + feeRate * (entry + stop);
  const riskQuantity = riskBudget == null || riskPerUnit == null ? null : riskBudget / riskPerUnit;
  const rewardPerUnit = target == null ? null : side * (target - entry) - feeRate * (entry + target);
  const rewardRisk = riskPerUnit == null || rewardPerUnit == null ? null : rewardPerUnit / riskPerUnit;
  const metrics = {
    quantity, notional, initialMargin, margin, liquidationPrice, pnl, fees, netPnl, roePct,
    fundingPayment, riskBudget, riskQuantity, riskNotional: riskQuantity == null ? null : riskQuantity * entry,
    riskMargin: riskQuantity == null ? null : riskQuantity * entry / leverage, rewardRisk,
  };
  if (!Object.values(metrics).every((value) => value == null || Number.isFinite(value))) throw new Error('参数组合超出可计算范围。');
  return {
    ...metrics,
    quality: 'estimated',
    assumptions: [
      '按单一逐仓线性合约、固定维持保证金档位计算。维持保证金率请使用对应合约档位。',
      '盈亏按输入价估算，实际成交可能滑点。资金费金额按输入的每期费率、标记价和期数计算。',
      '风险仓位按止损价和双边手续费估算。维持保证金率未填时省略清算价。',
    ],
    source: { url: liquidationsDoc, method: '按线性仓位权益等于维持保证金求解价格，收益按多空方向、价差和仓位计算。' },
  };
}

function apiNumber(value) {
  if (value == null || value === '' || !['number', 'string'].includes(typeof value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Query the address' positions on the first Hyperliquid perpetual DEX through documented public Info API. */
export async function loadWhale(address, { fetchImpl = globalThis.fetch } = {}) {
  const user = typeof address === 'string' ? address.trim().toLowerCase() : '';
  if (!/^0x[\da-f]{40}$/.test(user)) throw new Error('请输入 0x 开头的 42 字符公开钱包地址。');
  const payload = { type: 'clearinghouseState', user };
  let response;
  try {
    response = await fetchImpl(HYPERLIQUID_INFO, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8500),
    });
  } catch {
    throw new Error('无法连接 Hyperliquid 公开行情服务，请检查网络后重试。');
  }
  if (!response.ok) {
    const status = response.status;
    throw new Error(status === 429 ? 'Hyperliquid 查询过于频繁，请稍后重试。' : `Hyperliquid 查询失败（${status}）。`);
  }
  let snapshot;
  try { snapshot = await response.json(); }
  catch { throw new Error('Hyperliquid 返回了无法读取的数据。'); }
  if (!snapshot || !Array.isArray(snapshot.assetPositions) || !snapshot.marginSummary) throw new Error('Hyperliquid 返回的数据缺少仓位或保证金摘要。');
  const positions = [];
  for (const row of snapshot.assetPositions) {
    const position = row?.position;
    const signed = apiNumber(position?.szi);
    if (!signed || typeof position.coin !== 'string') continue;
    const quantity = Math.abs(signed);
    const notional = apiNumber(position.positionValue);
    const roe = apiNumber(position.returnOnEquity);
    positions.push({
      symbol: position.coin,
      side: signed > 0 ? 'long' : 'short',
      quantity,
      entryPrice: apiNumber(position.entryPx),
      markPrice: notional == null ? null : notional / quantity,
      liquidationPrice: apiNumber(position.liquidationPx),
      notional,
      leverage: apiNumber(position.leverage?.value),
      marginMode: position.leverage?.type ?? null,
      unrealizedPnl: apiNumber(position.unrealizedPnl),
      returnOnEquityPct: roe == null ? null : roe * 100,
    });
  }
  const snapshotTime = apiNumber(snapshot.time);
  const timestamp = snapshotTime != null && snapshotTime > 0 && snapshotTime <= 8.64e15 ? new Date(snapshotTime).toISOString() : null;
  const margin = snapshot.marginSummary;
  return {
    address: user,
    venue: 'Hyperliquid',
    timestamp,
    positions,
    summary: {
      accountValue: apiNumber(margin.accountValue),
      totalMarginUsed: apiNumber(margin.totalMarginUsed),
      totalNotional: apiNumber(margin.totalNtlPos),
      withdrawable: apiNumber(snapshot.withdrawable),
    },
    source: {
      url: HYPERLIQUID_INFO,
      documentation: HYPERLIQUID_PERPS_DOC,
      method: '读取指定公开地址在 Hyperliquid 主永续市场的仓位和保证金摘要。标记价以名义值除以仓位数量反推。',
    },
  };
}

const alertMetrics = new Set(['changePct', 'fundingRatePct', 'oiUsd', 'volumeUsd']);
const comparisons = new Map([
  ['gt', (value, threshold) => value > threshold],
  ['gte', (value, threshold) => value >= threshold],
  ['lt', (value, threshold) => value < threshold],
  ['lte', (value, threshold) => value <= threshold],
]);

/** Evaluate only explicitly supplied snapshots. This function performs no polling or notification. */
export function evaluateAlerts(rules, snapshots) {
  if (!Array.isArray(rules) || rules.length > 100) throw new Error('提醒规则应为至多 100 条的列表。');
  if (!Array.isArray(snapshots) || snapshots.length > 2500) throw new Error('行情快照应为至多 2500 个交易对的列表。');
  const bySymbol = new Map();
  for (const snapshot of snapshots) {
    if (!snapshot || typeof snapshot.symbol !== 'string' || !snapshot.symbol.trim()) continue;
    const symbol = snapshot.symbol.trim().toUpperCase();
    if (bySymbol.has(symbol)) throw new Error(`行情快照包含重复交易对 ${symbol}。`);
    bySymbol.set(symbol, snapshot);
  }
  const matches = [];
  const unavailable = [];
  const seen = new Set();
  let evaluated = 0;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || !rule.id || rule.id.length > 160) throw new Error('提醒规则缺少有效编号。');
    if (seen.has(rule.id)) throw new Error('提醒规则编号重复。');
    seen.add(rule.id);
    if (rule.enabled === false) continue;
    if (!alertMetrics.has(rule.metric) || !comparisons.has(rule.operator)) throw new Error('提醒规则包含不支持的指标或比较方式。');
    if (!Number.isFinite(rule.threshold)) throw new Error('提醒阈值需要填写有效数值。');
    if (rule.symbol != null && typeof rule.symbol !== 'string') throw new Error('提醒规则的交易对格式无效。');
    const symbol = rule.symbol?.trim().toUpperCase() || '*';
    const candidates = symbol === '*' ? bySymbol.entries() : [[symbol, bySymbol.get(symbol)]];
    if (symbol === '*' && !bySymbol.size) unavailable.push({ ruleId: rule.id, symbol, metric: rule.metric });
    for (const [observedSymbol, record] of candidates) {
      const value = record?.[rule.metric];
      if (!Number.isFinite(value)) {
        unavailable.push({ ruleId: rule.id, symbol: observedSymbol, metric: rule.metric });
        continue;
      }
      evaluated += 1;
      if (comparisons.get(rule.operator)(value, rule.threshold)) {
        matches.push({ ruleId: rule.id, symbol: observedSymbol, metric: rule.metric, operator: rule.operator, threshold: rule.threshold, value, timestamp: record.timestamp ?? null });
      }
    }
  }
  return { matches, unavailable, evaluated };
}
