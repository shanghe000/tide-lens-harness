const kinds = new Set(['horizontal', 'trend', 'measure']);
const limit = 100;
const colors = { horizontal: '#9cbaff', trend: '#ffd481', measure: '#ddaaff' };
const keyboardDirections = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1],
};

export function drawingKey(venue, symbol) {
  if (typeof venue !== 'string' || typeof symbol !== 'string') return null;
  const exchange = venue.trim().toLowerCase();
  const asset = symbol.trim().toUpperCase();
  return /^[a-z0-9-]{1,24}$/.test(exchange) && /^[A-Z0-9]{1,20}$/.test(asset) ? exchange + ':' + asset : null;
}

function validAnchor(value) {
  return Number.isSafeInteger(value?.ts) && value.ts > 0 && value.ts <= 8.64e15 &&
    Number.isFinite(value.price) && value.price > 0;
}

function copyAnchor(value) {
  return value ? { ts: value.ts, price: value.price } : null;
}

function distinct(from, to) {
  return from.ts !== to.ts || from.price !== to.price;
}

export function normalizeDrawings(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(-limit).flatMap(item => {
    if (!kinds.has(item?.type) || !validAnchor(item.from)) return [];
    const from = copyAnchor(item.from);
    if (item.type === 'horizontal') return [{ type: item.type, from }];
    if (!validAnchor(item.to) || !distinct(from, item.to)) return [];
    return [{ type: item.type, from, to: copyAnchor(item.to) }];
  });
}

export function measureDrawing(drawing) {
  if (drawing?.type !== 'measure' || !validAnchor(drawing.from) || !validAnchor(drawing.to)) return null;
  const { from, to } = drawing;
  const priceChange = to.price - from.price;
  const percentChange = 100 * (priceChange / from.price);
  return {
    priceChange,
    percentChange: Number.isFinite(percentChange) ? percentChange : null,
    elapsedMs: Math.abs(to.ts - from.ts),
  };
}

function chartBase(base) {
  if (!base?.g || typeof base.x !== 'function' || typeof base.y !== 'function') return null;
  const { left, right, top, bottom, min, max, low, high } = base;
  return [left, right, top, bottom, min, max, low, high].every(Number.isFinite) &&
    right > left && bottom > top && min > 0 && max >= min && low > 0 && high > low ? base : null;
}

function pointerAnchor(event, base) {
  const rect = event.currentTarget?.getBoundingClientRect?.();
  if (!rect || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const { left, right, top, bottom, min, max, low, high } = base;
  if (x < left || x > right || y < top || y > bottom) return null;
  return {
    ts: Math.round(min + (max - min) * ((x - left) / (right - left))),
    price: low + (high - low) * ((bottom - y) / (bottom - top)),
  };
}

function boundedAnchor(base, from, horizontal, vertical, shift) {
  const { min, max, low, high } = base;
  const center = { ts: Math.round(min + (max - min) / 2), price: low + (high - low) / 2 };
  const start = from ?? center;
  const scale = shift ? 5 : 1;
  const timeStep = Math.max(1, Math.round((max - min) / 50)) * scale;
  const priceStep = (high - low) / 50 * scale;
  return {
    ts: Math.min(max, Math.max(min, start.ts + horizontal * timeStep)),
    price: Math.min(high, Math.max(low, start.price + vertical * priceStep)),
  };
}

function projected(base, point) {
  if (!point) return null;
  const x = base.x(point.ts);
  const y = base.y(point.price);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function strokeSegment(g, from, to) {
  g.beginPath();
  g.moveTo(from.x, from.y);
  g.lineTo(to.x, to.y);
  g.stroke();
}

function marker(g, point) {
  g.beginPath();
  g.arc(point.x, point.y, 3, 0, Math.PI * 2);
  g.fill();
}

function draw(base, item, preview = false) {
  const { g, left, right, top, bottom } = base;
  const from = projected(base, item.from);
  if (!from) return;
  const { type } = item;
  g.strokeStyle = g.fillStyle = colors[type];
  g.lineWidth = preview ? 1 : 1.5;
  g.setLineDash(preview || type === 'measure' ? [5, 4] : []);

  if (type === 'horizontal') {
    if (from.y >= top && from.y <= bottom) strokeSegment(g, { x: left, y: from.y }, { x: right, y: from.y });
    return;
  }
  const to = projected(base, item.to);
  if (!to) {
    marker(g, from);
    return;
  }
  if (type === 'measure') {
    g.globalAlpha = 0.13;
    g.fillRect(Math.min(from.x, to.x), Math.min(from.y, to.y), Math.abs(from.x - to.x), Math.abs(from.y - to.y));
    g.globalAlpha = 1;
  }
  strokeSegment(g, from, to);
  marker(g, from);
  marker(g, to);
}

export function createDrawingController({ load = () => [], save = () => {}, change = () => {} } = {}) {
  const markets = new Map();
  const pendingSaves = new Map();
  let key = null;
  let tool = 'cursor';
  let items = [];
  let base = null;
  let anchor = null;
  let position = null;
  let storageError = null;

  function snapshot() {
    const previous = items.findLast(item => item.type === 'measure');
    const preview = tool === 'measure' && anchor && position ? { type: tool, from: anchor, to: position } : null;
    return {
      key, tool, items: normalizeDrawings(items), anchor: copyAnchor(anchor), position: copyAnchor(position),
      measurement: measureDrawing(preview ?? previous),
      storageError,
    };
  }

  function notify() {
    change(snapshot());
  }

  function commit(next) {
    if (!key) return false;
    items = normalizeDrawings(next);
    const savedKey = key;
    const entry = { items, storageError: null };
    markets.set(savedKey, entry);
    storageError = null;
    let published = false;

    function failed() {
      if (markets.get(savedKey) !== entry) return;
      entry.storageError = '本机未能保存绘图。';
      if (key === savedKey) {
        storageError = entry.storageError;
        if (published) notify();
      }
    }

    function write() {
      try {
        const result = save(savedKey, normalizeDrawings(entry.items));
        if (typeof result?.then === 'function') return Promise.resolve(result).catch(failed);
      } catch {
        failed();
      }
      return null;
    }

    const previous = pendingSaves.get(savedKey);
    const pending = previous ? previous.then(write) : write();
    if (pending) {
      pendingSaves.set(savedKey, pending);
      void pending.then(() => {
        if (pendingSaves.get(savedKey) === pending) pendingSaves.delete(savedKey);
      });
    }
    published = true;
    notify();
    return true;
  }

  function setMarket(venue, symbol) {
    const next = drawingKey(venue, symbol);
    if (next === key) return false;
    key = next;
    items = [];
    storageError = null;
    if (key) {
      const cached = markets.get(key);
      if (cached) {
        ({ items, storageError } = cached);
      } else {
        try {
          items = normalizeDrawings(load(key));
        } catch {
          storageError = '本机未能读取已保存的绘图。';
        }
        markets.set(key, { items, storageError });
      }
    }
    base = anchor = position = null;
    notify();
    return true;
  }

  function setTool(next) {
    if ((next !== 'cursor' && !kinds.has(next)) || next === tool) return false;
    tool = next;
    anchor = position = null;
    notify();
    return true;
  }

  function setBase(next) {
    base = chartBase(next);
  }

  function pointer(event) {
    if (tool === 'cursor') return false;
    const next = base && pointerAnchor(event, base);
    if (next && (!position || distinct(position, next))) {
      position = next;
      notify();
    }
    return true;
  }

  function pin(next) {
    if (!key || !validAnchor(next)) return false;
    position = next;
    if (tool === 'horizontal') return commit([...items, { type: tool, from: position }]);
    if (!anchor) {
      anchor = position;
      notify();
      return true;
    }
    if (!distinct(anchor, position)) return false;
    const drawing = { type: tool, from: anchor, to: position };
    anchor = null;
    return commit([...items, drawing]);
  }

  function click(event) {
    if (tool === 'cursor') return false;
    if (event.button != null && event.button !== 0) return false;
    if (base && pin(pointerAnchor(event, base))) event.currentTarget?.focus?.({ preventScroll: true });
    return true;
  }

  function onKey(event) {
    if (tool === 'cursor' || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === 'Escape') {
      if (anchor) {
        anchor = position = null;
        notify();
      } else {
        setTool('cursor');
      }
    } else if (Object.hasOwn(keyboardDirections, event.key)) {
      if (base) {
        position = boundedAnchor(base, position, ...keyboardDirections[event.key], event.shiftKey);
        notify();
      }
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (base && !event.repeat) pin(boundedAnchor(base, position, 0, 0));
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  function leave() {
    if (tool === 'cursor' || !position) return false;
    position = null;
    notify();
    return true;
  }

  function render() {
    if (!base) return;
    const { g, left, right, top, bottom } = base;
    g.save();
    g.beginPath();
    g.rect(left, top, right - left, bottom - top);
    g.clip();
    for (const item of items) draw(base, item);
    if (tool === 'horizontal' && position) draw(base, { type: tool, from: position }, true);
    if (anchor) draw(base, { type: tool, from: anchor, to: position }, true);
    if (tool !== 'cursor' && position) {
      const current = projected(base, position);
      if (current) {
        g.fillStyle = colors[tool];
        marker(g, current);
      }
    }
    g.restore();
  }

  function clear() {
    if (!items.length) return false;
    anchor = position = null;
    return commit([]);
  }

  return {
    setMarket, setTool, setBase, pointer, click, leave, key: onKey, render, snapshot,
    undo: () => items.length > 0 && commit(items.slice(0, -1)),
    clear,
  };
}
