import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const venues = ['okx', 'binance', 'bybit'];
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maxBytes = 16 * 1024 * 1024;
const maxFrames = 5_760;
const maxEvents = 12_000;
const version = 1;
const streamDocs = {
  binance: {
    url: 'https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Liquidation-Order-Streams',
    label: 'Binance 公开强平推送',
    method: '每个合约每秒最多披露一条；记录已成交数量和平均成交价，无法据此还原全量。',
    quality: 'measured',
  },
  bybit: {
    url: 'https://bybit-exchange.github.io/docs/v5/websocket/public/all-liquidation',
    label: 'Bybit 公开强平推送',
    method: '记录连接在线期间收到的 allLiquidation 消息；名义值按公开破产价折算。',
    quality: 'measured',
  },
};
const unavailable = '此时未收到公开记录，不能推断没有强平。';
const rawKeys = new Set(['instId', 'ts', 'posSide', 'bkPx', 'sz', 'side', 'e', 'E', 's', 'S',
  'o', 'f', 'q', 'p', 'ap', 'X', 'l', 'z', 'T', 'v', 'contractFactor']);
const sourceHosts = new Set(['www.okx.com', 'openapi.okx.com', 'fapi.binance.com', 'developers.binance.com',
  'api.bybit.com', 'bybit-exchange.github.io']);

function timestamp(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;
}

function cleanText(value, limit = 300) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function requestMarket({ venue, symbol } = {}) {
  const market = String(venue ?? '').trim().toLowerCase();
  const coin = String(symbol ?? '').trim().toUpperCase().replace(/-USDT-SWAP$|USDT$/u, '');
  if (!venues.includes(market) || !/^[A-Z0-9]{1,20}$/.test(coin)) {
    throw new RangeError('请选择有效的交易所和 USDT 本位合约。');
  }
  return { venue: market, symbol: coin };
}

function source(value, fallback = null) {
  if (!value) return fallback;
  let url = null;
  try {
    const parsed = new URL(value.url);
    if (parsed.protocol === 'https:' && sourceHosts.has(parsed.host) && !parsed.username && !parsed.password) {
      url = parsed.href;
    }
  } catch {}
  const quality = ['measured', 'estimated', 'missing'].includes(value.quality) ? value.quality : 'missing';
  return { url, label: cleanText(value.label), method: cleanText(value.method, 600), quality };
}

function normalizeLevel(row) {
  if (!Number.isFinite(row?.price) || row.price <= 0 || !Number.isFinite(row.size) || row.size <= 0 ||
      !Number.isFinite(row.price * row.size)) return null;
  return { price: row.price, size: row.size, notional: row.price * row.size };
}

function normalizeBook(book) {
  if (!timestamp(book?.ts) || !Array.isArray(book.bids) || !Array.isArray(book.asks)) return null;
  const bids = book.bids.slice(0, 100).map(normalizeLevel).filter(Boolean);
  const asks = book.asks.slice(0, 100).map(normalizeLevel).filter(Boolean);
  return bids.length && asks.length ? { ts: book.ts, bids, asks } : null;
}

function liquidation(row) {
  const level = normalizeLevel(row);
  if (!level || !timestamp(row.ts) || !['long', 'short'].includes(row.side) || !cleanText(row.id)) return null;
  const raw = {};
  for (const [key, value] of Object.entries(row.raw ?? {})) {
    if (rawKeys.has(key) && (Number.isFinite(value) || typeof value === 'string')) {
      raw[key] = typeof value === 'string' ? cleanText(value, 60) : value;
    }
  }
  return {
    ...level, ts: row.ts, side: row.side, id: cleanText(row.id),
    ...(Object.keys(raw).length ? { raw } : {}),
  };
}

function number(raw) {
  return typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
}

export function parseLiquidationMessage(venue, symbol, message) {
  const pair = symbol + 'USDT';
  if (venue === 'binance') {
    const event = message?.data ?? message;
    const row = event?.o;
    if (event?.e !== 'forceOrder' || row?.s !== pair || (event.st != null && event.st !== 1)) return [];
    const side = { SELL: 'long', BUY: 'short' }[row.S];
    const price = number(row.ap);
    const size = number(row.z);
    const entry = liquidation({
      ts: row.T, price, size, side, id: [row.T, side, price, size].join(':'),
      raw: { ...row, e: event.e, E: event.E },
    });
    return entry ? [entry] : [];
  }
  if (venue !== 'bybit' || message?.topic !== 'allLiquidation.' + pair || !Array.isArray(message.data)) return [];
  const occurrences = new Map();
  return message.data.flatMap(row => {
    if (row?.s !== pair) return [];
    const side = { Buy: 'long', Sell: 'short' }[row.S];
    const price = number(row.p);
    const size = number(row.v);
    const baseId = [row.T, side, price, size].join(':');
    const index = occurrences.get(baseId) ?? 0;
    occurrences.set(baseId, index + 1);
    const entry = liquidation({ ts: row.T, price, size, side, id: baseId + ':' + index, raw: row });
    return entry ? [entry] : [];
  });
}

function normalizeFrame(row) {
  if (!timestamp(row.ts) || !Array.isArray(row.liquidations) || row.liquidations.length > 1000 ||
      !Array.isArray(row.gaps) || row.gaps.length > 5) return null;
  const book = normalizeBook(row.book);
  const recent = row.liquidations.map(liquidation);
  if (recent.some(event => !event || event.ts > row.ts) ||
      (row.book !== null && (!book || book.bids.length !== row.book.bids.length || book.asks.length !== row.book.asks.length))) {
    return null;
  }
  return {
    type: 'frame', ts: row.ts, book, liquidations: recent,
    sources: {
      book: source(row.sources?.book),
      liquidations: source(row.sources?.liquidations),
    },
    gaps: row.gaps.map(gap => cleanText(gap)),
    streamStatus: ['connected', 'connecting', 'disconnected', 'unavailable'].includes(row.streamStatus)
      ? row.streamStatus : null,
  };
}

function decode(text, imported = false) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxBytes) throw new RangeError('复盘文件超过 16 MB。');
  const lines = text.split(/\r?\n/u).filter(line => line.trim());
  if (lines.length < 1 || lines.length > maxFrames + maxEvents + 2) throw new RangeError('复盘文件没有内容或记录过多。');
  let rows;
  try { rows = lines.map(line => JSON.parse(line)); } catch { throw new RangeError('复盘文件需要逐行有效的 NDJSON。'); }
  const header = rows[0];
  if (header?.type !== 'session' || header.version !== version || !timestamp(header.startedAt)) {
    throw new RangeError('复盘文件头缺少受支持的版本或时间。');
  }
  const market = requestMarket(header);
  const session = {
    type: 'session', version, ...market, startedAt: header.startedAt,
    origin: imported || header.origin === 'imported' ? 'imported' : 'recorded',
  };
  const frames = [];
  const events = new Map();
  let endedAt = null;
  let state = 'interrupted';

  function addEvent(event) {
    if (!event || event.ts < session.startedAt || (!events.has(event.id) && events.size >= maxEvents)) {
      throw new RangeError('复盘强平记录无效。');
    }
    const existing = events.get(event.id);
    if (existing && (event.ts !== existing.ts || event.price !== existing.price ||
        event.size !== existing.size || event.side !== existing.side)) {
      throw new RangeError('复盘的同一强平记录包含不同观测值。');
    }
    if (!existing) events.set(event.id, { type: 'liquidation', ...event });
  }

  for (const row of rows.slice(1)) {
    if (!row || typeof row !== 'object' || endedAt !== null) throw new RangeError('复盘文件记录顺序无效。');
    if (row.type === 'frame') {
      const frame = normalizeFrame(row);
      if (!frame || frame.ts < session.startedAt || frame.ts < (frames.at(-1)?.ts ?? 0) || frames.length >= maxFrames) {
        throw new RangeError('复盘盘口快照无效或时间逆序。');
      }
      frames.push(frame);
      frame.liquidations.forEach(addEvent);
    } else if (row.type === 'liquidation') {
      addEvent(liquidation(row));
    } else if (row.type === 'stop' && timestamp(row.ts) && row.ts >= session.startedAt) {
      endedAt = row.ts;
      state = row.reason === 'limit' ? 'limit' : row.reason === 'error' ? 'error' : 'stopped';
    } else {
      throw new RangeError('复盘文件包含不支持的记录。');
    }
  }
  if (imported && !frames.length && !events.size) throw new RangeError('复盘文件中没有盘口或强平记录。');
  if (endedAt !== null && (frames.at(-1)?.ts > endedAt || [...events.values()].some(event => event.ts > endedAt))) {
    throw new RangeError('复盘结束时间早于数据记录。');
  }
  return { session, frames, events, endedAt, state };
}

function savedRecords(text) {
  if (text.endsWith('\n')) return text;
  const lastCompleteLine = text.lastIndexOf('\n');
  if (lastCompleteLine < 0) throw new RangeError('复盘文件头写入中断。');
  return text.slice(0, lastCompleteLine + 1);
}

function summary(id, session, state, frames, endedAt, { firstFrameAt = null, lastFrameAt = null, lastEventAt = null } = {}) {
  const { venue, symbol, startedAt, origin } = session;
  return { id, venue, symbol, startedAt, origin, state, frames, endedAt, firstFrameAt, lastFrameAt, lastEventAt };
}

function sessionSummary(id, data, state = data.state) {
  let lastEventAt = null;
  for (const row of data.events.values()) lastEventAt = Math.max(lastEventAt ?? 0, row.ts);
  return summary(id, data.session, state, data.frames.length, data.endedAt, {
    firstFrameAt: data.frames[0]?.ts, lastFrameAt: data.frames.at(-1)?.ts, lastEventAt,
  });
}

function encode(row) {
  return JSON.stringify(row) + '\n';
}

async function appender(path, text) {
  const file = await open(path, 'r+', 0o600);
  let size;
  try {
    size = (await file.stat()).size;
    const data = Buffer.from(text);
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await file.write(data, offset, data.length - offset, size + offset);
      if (!bytesWritten) throw new Error('复盘写入中断。');
      offset += bytesWritten;
    }
  } catch (error) {
    if (size !== undefined) await file.truncate(size).catch(() => {});
    throw error;
  } finally { await file.close(); }
}

export function createReplay({
  dataDirectory,
  marketLoader,
  now = Date.now,
  intervalMs = 15_000,
  connectWebSocket = url => new WebSocket(url),
} = {}) {
  const directory = join(dataDirectory, 'replays');
  const active = new Map();
  let closed = false;
  const pathFor = id => {
    if (typeof id !== 'string' || !idPattern.test(id)) throw new RangeError('复盘 ID 无效。');
    return join(directory, id + '.ndjson');
  };

  async function contents(id) {
    const path = pathFor(id);
    const recorder = active.get(id);
    if (recorder) await recorder.pending;
    try {
      const file = await open(path);
      try {
        const size = Math.min((await file.stat()).size, recorder?.writtenBytes ?? Infinity);
        if (size > maxBytes) throw new RangeError('复盘文件超过 16 MB。');
        const buffer = Buffer.alloc(size);
        let offset = 0;
        while (offset < size) {
          const { bytesRead } = await file.read(buffer, offset, size - offset, offset);
          if (bytesRead === 0) throw new Error('复盘读取中断。');
          offset += bytesRead;
        }
        return savedRecords(buffer.toString('utf8'));
      } finally { await file.close(); }
    }
    catch (error) {
      if (error.code === 'ENOENT') throw new RangeError('找不到这份复盘。');
      throw error;
    }
  }

  async function list() {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const rows = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.ndjson') || !idPattern.test(entry.name.slice(0, -7))) continue;
      const id = entry.name.slice(0, -7);
      const recorder = active.get(id);
      if (recorder) {
        rows.push(summary(id, recorder.session, 'recording', recorder.frameCount, null, recorder));
        continue;
      }
      try {
        rows.push(sessionSummary(id, decode(await contents(id))));
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    }
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  }

  function save(recorder, row) {
    const line = encode(row);
    const nextSize = recorder.bytes + Buffer.byteLength(line);
    if (nextSize > maxBytes - 256) {
      void stop(recorder.id, 'limit').catch(() => {});
      return false;
    }
    recorder.bytes = nextSize;
    recorder.pending = recorder.pending.then(async () => {
      await appender(recorder.path, line);
      recorder.writtenBytes = nextSize;
    });
    recorder.pending.catch(() => { void stop(recorder.id, 'error').catch(() => {}); });
    return true;
  }

  function registerEvent(recorder, entry) {
    if (recorder.finishing || entry.ts < recorder.session.startedAt || recorder.seen.has(entry.id)) return;
    if (recorder.seen.size >= maxEvents) {
      void stop(recorder.id, 'limit').catch(() => {});
      return;
    }
    if (save(recorder, { type: 'liquidation', ...entry })) {
      recorder.seen.add(entry.id);
      recorder.lastEventAt = Math.max(recorder.lastEventAt ?? 0, entry.ts);
    }
  }

  function attachStream(recorder) {
    const { venue, symbol } = recorder.session;
    if (!Object.hasOwn(streamDocs, venue) || recorder.finishing) return;
    let socket;
    let timer;
    let heartbeat;
    let lastPongAt;
    const bybit = venue === 'bybit';
    recorder.streamStatus = 'connecting';
    const reconnect = () => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      if (recorder.finishing || recorder.socket !== socket) return;
      recorder.socket = null;
      recorder.streamStatus = 'disconnected';
      recorder.streamGaps++;
      recorder.reconnect = setTimeout(() => attachStream(recorder), 5_000);
      recorder.reconnect.unref?.();
      try { socket?.close(); } catch {}
    };
    try {
      socket = connectWebSocket(bybit ? 'wss://stream.bybit.com/v5/public/linear'
        : 'wss://fstream.binance.com/market/ws/' + symbol.toLowerCase() + 'usdt@forceOrder');
      recorder.socket = socket;
    } catch {
      recorder.socket = null;
      socket = null;
      reconnect();
      return;
    }
    timer = setTimeout(reconnect, 10_000);
    timer.unref?.();
    recorder.clearSocket = () => { clearTimeout(timer); clearInterval(heartbeat); };
    socket.addEventListener('open', () => {
      if (recorder.finishing || recorder.socket !== socket) return;
      if (!bybit) {
        clearTimeout(timer);
        recorder.streamStatus = 'connected';
        return;
      }
      try {
        socket.send(JSON.stringify({ op: 'subscribe', args: ['allLiquidation.' + symbol + 'USDT'] }));
        lastPongAt = now();
        heartbeat = setInterval(() => {
          if (now() - lastPongAt > 45_000) { reconnect(); return; }
          try { socket.send(JSON.stringify({ op: 'ping' })); } catch { reconnect(); }
        }, 20_000);
        heartbeat.unref?.();
      } catch { reconnect(); }
    });
    socket.addEventListener('message', event => {
      if (recorder.finishing || recorder.socket !== socket || typeof event.data !== 'string' || event.data.length > 1_000_000) return;
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (bybit && payload?.op === 'subscribe') {
        if (payload.success !== true) { reconnect(); return; }
        clearTimeout(timer);
        recorder.streamStatus = 'connected';
      }
      if (bybit && (payload?.op === 'pong' || payload?.ret_msg === 'pong')) lastPongAt = now();
      for (const row of parseLiquidationMessage(venue, symbol, payload)) registerEvent(recorder, row);
    });
    socket.addEventListener('error', reconnect);
    socket.addEventListener('close', reconnect);
  }

  async function collect(recorder) {
    const { venue, symbol, startedAt } = recorder.session;
    const gaps = [];
    let market;
    try { market = await marketLoader({ venue, symbol, window: '1h' }); }
    catch { gaps.push('公共行情采样失败。'); }
    if (recorder.finishing) return;
    const ts = Math.max(startedAt, recorder.lastFrameAt ?? 0, now());
    const book = normalizeBook(market?.book);
    if (!book) gaps.push(cleanText(market?.errors?.book) || '此时没有可用的盘口快照。');
    if (book && ts - book.ts > intervalMs * 2) gaps.push('交易所返回的盘口时间早于此采样时点。');
    const recent = venue === 'okx' ? (market?.liquidations ?? []).map(liquidation).filter(row => row && row.ts >= startedAt && row.ts <= ts) : [];
    if (venue === 'okx' && !recent.length) gaps.push(cleanText(market?.errors?.liquidations) || unavailable);
    if (venue !== 'okx' && recorder.streamStatus !== 'connected') gaps.push('公开强平 WebSocket 尚未连接，期间记录可能缺失。');
    if (recorder.streamGaps) gaps.push('自上次采样以来，公开强平连接曾中断。');
    recorder.streamGaps = 0;
    for (const entry of recent) registerEvent(recorder, entry);
    const bookSource = source(market?.sources?.book);
    const liquidationSource = venue === 'okx' ? source(market?.sources?.liquidations) : streamDocs[venue];
    if (!recorder.finishing && save(recorder, {
      type: 'frame', ts, book, liquidations: [], streamStatus: recorder.streamStatus,
      sources: {
        book: !book && bookSource ? { ...bookSource, quality: 'missing' } : bookSource,
        liquidations: market?.errors?.liquidations && venue === 'okx' && liquidationSource
          ? { ...liquidationSource, quality: 'missing' } : liquidationSource,
      },
      gaps,
    })) {
      recorder.firstFrameAt ??= ts;
      recorder.lastFrameAt = ts;
      recorder.frameCount++;
      if (recorder.frameCount >= maxFrames) void stop(recorder.id, 'limit').catch(() => {});
    }
  }

  function tick(recorder) {
    recorder.collecting = collect(recorder);
    recorder.collecting.then(() => {
      if (recorder.finishing) return;
      recorder.timer = setTimeout(() => tick(recorder), intervalMs);
      recorder.timer.unref?.();
    }).catch(() => { void stop(recorder.id, 'error').catch(() => {}); });
  }

  async function start(input) {
    if (closed || typeof marketLoader !== 'function') throw new RangeError('当前无法启动录制。');
    if (active.size) throw new RangeError('请先停止正在进行的复盘录制。');
    const id = randomUUID();
    const session = { type: 'session', version, ...requestMarket(input), origin: 'recorded', startedAt: now() };
    const path = pathFor(id);
    const header = encode(session);
    const recorder = {
      id, session, path, bytes: Buffer.byteLength(header), writtenBytes: Buffer.byteLength(header), frameCount: 0,
      pending: Promise.resolve(), seen: new Set(), streamStatus: 'unavailable', streamGaps: 0, socket: null,
    };
    active.set(id, recorder);
    recorder.pending = mkdir(directory, { recursive: true, mode: 0o700 }).then(() =>
      writeFile(path, header, { flag: 'wx', mode: 0o600 }));
    try { await recorder.pending; }
    catch (error) { active.delete(id); throw error; }
    if (!recorder.finishing) {
      attachStream(recorder);
      tick(recorder);
    }
    return summary(id, session, 'recording', recorder.frameCount, null, recorder);
  }

  async function stop(id, reason) {
    pathFor(id);
    const recorder = active.get(id);
    if (!recorder) {
      const data = decode(await contents(id));
      return sessionSummary(id, data);
    }
    if (recorder.stopping) return recorder.stopping;
    recorder.finishing = true;
    const endedAt = Math.max(now(), recorder.session.startedAt, recorder.lastFrameAt ?? 0, recorder.lastEventAt ?? 0);
    recorder.stopping = (async () => {
      clearTimeout(recorder.timer);
      clearTimeout(recorder.reconnect);
      recorder.clearSocket?.();
      try { recorder.socket?.close(); } catch {}
      try {
        await recorder.pending.catch(() => {});
        await appender(recorder.path, encode({ type: 'stop', ts: endedAt, reason }));
      } finally { active.delete(id); }
      return summary(id, recorder.session, reason ?? 'stopped', recorder.frameCount, endedAt, recorder);
    })();
    return recorder.stopping;
  }

  async function get({ id, ts } = {}) {
    const recorder = active.get(id);
    if (ts != null && !timestamp(ts)) throw new RangeError('复盘时间无效。');
    const data = decode(await contents(id));
    const timeline = [...new Set([...data.frames.map(frame => frame.ts), ...[...data.events.values()].map(event => event.ts)])]
      .sort((a, b) => a - b).map(ts => ({ ts }));
    const session = sessionSummary(id, data, recorder && !data.endedAt ? 'recording' : data.state);
    const selected = ts ?? timeline.at(-1)?.ts ?? data.endedAt ?? now();
    const frame = data.frames.findLast(row => row.ts <= selected) ?? null;
    const prior = frame ? data.frames.findLast(row => row.ts < frame.ts)?.ts : null;
    const liquidations = [...data.events.values()]
      .filter(row => row.ts <= selected && (prior == null || row.ts > prior))
      .map(({ type, ...row }) => row).sort((a, b) => b.ts - a.ts);
    return {
      session,
      timeline, frame: frame ? { ...frame, liquidations } : null, liquidations,
      requestedAt: selected,
      stale: Boolean(frame && selected - frame.ts > intervalMs * 2),
      liquidationSource: frame?.sources.liquidations ?? streamDocs[data.session.venue] ?? null,
    };
  }

  async function importNDJSON(text) {
    const data = decode(text, true);
    const id = randomUUID();
    const endedAt = data.endedAt ?? Math.max(data.session.startedAt, data.frames.at(-1)?.ts ?? 0,
      ...[...data.events.values()].map(row => row.ts));
    const rows = [data.session, ...data.frames, ...data.events.values(), { type: 'stop', ts: endedAt }];
    const contents = rows.map(encode).join('');
    if (Buffer.byteLength(contents) > maxBytes) throw new RangeError('规范化后的复盘文件超过 16 MB。');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, '.' + id + '.tmp');
    try {
      await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
      await rename(temporary, pathFor(id));
    } finally { await rm(temporary, { force: true }); }
    return sessionSummary(id, { ...data, endedAt }, 'stopped');
  }

  async function exportNDJSON(id) {
    const value = await contents(id);
    decode(value);
    return value;
  }

  async function close() {
    closed = true;
    await Promise.allSettled([...active.keys()].map(id => stop(id)));
  }

  return { list, start, stop, get, importNDJSON, exportNDJSON, close };
}
