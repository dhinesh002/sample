const STORAGE_KEY = "live-screener-room";
const TIMEFRAMES = ["1m", "5m", "15m", "1H", "4H", "D"];
const TF_MS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1H": 3_600_000,
  "4H": 14_400_000,
  D: 86_400_000,
};
const TF_COUNT = { "1m": 120, "5m": 96, "15m": 80, "1H": 64, "4H": 48, D: 36 };
const SPEED_MS = { 1: 760, 2: 520, 3: 340, 4: 220, 5: 130 };
const SPEED_LABEL = { 1: "Slow", 2: "Relaxed", 3: "Normal", 4: "Fast", 5: "Tape" };
const GROUPS = ["All", "Index", "Energy", "Metals", "FX", "Rates"];

const DEFS = [
  { id: "NQ", name: "E-mini Nasdaq", group: "Index", tick: 0.25, open: 21480.25, base: 280 },
  { id: "ES", name: "E-mini S&P", group: "Index", tick: 0.25, open: 6124.5, base: 420 },
  { id: "RTY", name: "E-mini Russell", group: "Index", tick: 0.1, open: 2418.2, base: 90 },
  { id: "YM", name: "E-mini Dow", group: "Index", tick: 1, open: 44820, base: 45 },
  { id: "CL", name: "Crude Oil", group: "Energy", tick: 0.01, open: 71.84, base: 140 },
  { id: "GC", name: "Gold", group: "Metals", tick: 0.1, open: 2684.5, base: 36 },
  { id: "SI", name: "Silver", group: "Metals", tick: 0.005, open: 32.415, base: 48 },
  { id: "6E", name: "Euro FX", group: "FX", tick: 0.00005, open: 1.0842, base: 60 },
  { id: "ZB", name: "30-Year Bond", group: "Rates", tick: 0.03125, open: 118.21875, base: 42, bond: true },
  { id: "ZN", name: "10-Year Note", group: "Rates", tick: 0.015625, open: 110.15625, base: 70, bond: true },
  { id: "MNQ", name: "Micro Nasdaq", group: "Index", tick: 0.25, open: 21478, base: 95 },
  { id: "MES", name: "Micro S&P", group: "Index", tick: 0.25, open: 6124, base: 130 },
];

const state = {
  view: "room",
  symbol: "NQ",
  timeframe: "5m",
  tab: "screener",
  group: "All",
  sort: { key: "id", dir: 1 },
  query: "",
  watchQuery: "",
  hover: null,
  working: null,
  symbols: [],
  books: {},
  prints: [],
  signals: [],
  signalAt: {},
  simNow: Date.now(),
  timer: 0,
  settings: { speed: 3, showVolume: true, compact: false },
  journal: [],
};

const $ = (id) => document.getElementById(id);

function tickDecimals(tick) {
  const text = tick.toFixed(10).replace(/0+$/, "");
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

function roundTick(price, tick) {
  const steps = Math.round(price / tick);
  return Number((steps * tick).toFixed(tickDecimals(tick)));
}

function randInt(min, max) {
  const a = Math.ceil(Math.min(min, max));
  const b = Math.floor(Math.max(min, max));
  return a + Math.floor(Math.random() * (b - a + 1));
}

function fmt(sym, price) {
  if (sym.bond) {
    const whole = Math.floor(price + 1e-8);
    const frac = Math.round((price - whole) / sym.tick);
    return `${whole}'${String(frac).padStart(2, "0")}`;
  }
  return price.toLocaleString("en-US", {
    minimumFractionDigits: sym.dp,
    maximumFractionDigits: sym.dp,
  });
}

function fmtSize(n) {
  return Math.round(n).toLocaleString("en-US");
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtClock(ts, tf) {
  const d = new Date(ts);
  if (tf === "D") return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function signed(sym, delta) {
  const sign = delta > 0 ? "+" : delta < 0 ? "-" : "";
  if (sym.bond) return `${sign}${Math.abs(Math.round(delta / sym.tick))} ticks`;
  return `${sign}${fmt(sym, Math.abs(delta))}`;
}

function changeOf(sym) {
  const delta = sym.price - sym.sessionOpen;
  const pct = sym.sessionOpen ? (delta / sym.sessionOpen) * 100 : 0;
  return { delta, pct };
}

function dirClass(n) {
  if (n > 0) return "up";
  if (n < 0) return "down";
  return "flat";
}

function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

function current() {
  return state.symbols.find((sym) => sym.id === state.symbol) || state.symbols[0];
}

function blankCandle(t, price) {
  return { t, o: price, h: price, l: price, c: price, v: 0, bidV: 0, askV: 0, delta: 0, levels: {} };
}

function addTrade(candle, price, size, isBuy) {
  candle.c = price;
  candle.h = Math.max(candle.h, price);
  candle.l = Math.min(candle.l, price);
  candle.v += size;
  if (isBuy) candle.askV += size;
  else candle.bidV += size;
  candle.delta = candle.askV - candle.bidV;
  const key = price.toFixed(8);
  if (!candle.levels[key]) candle.levels[key] = { p: price, bid: 0, ask: 0 };
  if (isBuy) candle.levels[key].ask += size;
  else candle.levels[key].bid += size;
}

function buildHistory(sym) {
  state.books[sym.id] = {};
  for (const tf of TIMEFRAMES) {
    const ms = TF_MS[tf];
    const count = TF_COUNT[tf];
    const jump = tf === "D" ? 10 : tf === "4H" ? 6 : tf === "1H" ? 3 : tf === "15m" ? 2 : 1;
    let price = roundTick(sym.target * (1 + (Math.random() - 0.5) * 0.004), sym.tick);
    const start = Math.floor(Date.now() / ms) * ms - (count - 1) * ms;
    const candles = [];
    for (let i = 0; i < count; i++) {
      const drift = (sym.target - price) / Math.max(1, count - i);
      const candle = blankCandle(start + i * ms, price);
      const steps = tf === "D" || tf === "4H" ? 18 : 10;
      for (let s = 0; s < steps; s++) {
        const shock = (Math.random() - 0.47) * sym.tick * jump * randInt(1, 4);
        price = roundTick(price + shock + drift / steps, sym.tick);
        const size = randInt(1, Math.max(4, Math.round(sym.base / 8)));
        addTrade(candle, price, size, price >= candle.o);
      }
      candles.push(candle);
    }
    state.books[sym.id][tf] = candles;
  }
  const minute = state.books[sym.id]["1m"];
  const last = minute[minute.length - 1];
  sym.price = last.c;
  sym.prev = last.c;
  sym.sessionOpen = minute[0].o;
  sym.high = minute.reduce((max, candle) => Math.max(max, candle.h), last.h);
  sym.low = minute.reduce((min, candle) => Math.min(min, candle.l), last.l);
  sym.sessionVolume = minute.reduce((sum, candle) => sum + candle.v, 0);
  sym.sessionDelta = minute.reduce((sum, candle) => sum + candle.delta, 0);
  for (const tf of TIMEFRAMES) {
    const candle = state.books[sym.id][tf].at(-1);
    candle.c = sym.price;
    candle.h = Math.max(candle.h, sym.price);
    candle.l = Math.min(candle.l, sym.price);
  }
}

function seedPrints() {
  const seeded = [];
  for (const sym of state.symbols) {
    const heavy = state.books[sym.id]["1m"]
      .filter((candle) => candle.v >= sym.printMin * 0.7)
      .slice(-3);
    for (const candle of heavy) {
      seeded.push({
        id: `${sym.id}-${candle.t}`,
        sym: sym.id,
        price: candle.c,
        size: candle.v,
        isBuy: candle.delta >= 0,
        t: candle.t + TF_MS["1m"] - 1000,
      });
    }
  }
  seeded.sort((a, b) => b.t - a.t);
  state.prints = seeded.slice(0, 36);
}

function initMarket() {
  state.simNow = Date.now();
  state.prints = [];
  state.signals = [];
  state.signalAt = {};
  state.working = null;
  state.hover = null;
  state.symbols = DEFS.map((def) => ({
    ...def,
    dp: tickDecimals(def.tick),
    target: def.open,
    printMin: Math.max(24, Math.round(def.base * 0.55)),
    price: def.open,
    prev: def.open,
    sessionOpen: def.open,
    high: def.open,
    low: def.open,
    sessionVolume: 0,
    sessionDelta: 0,
  }));
  for (const sym of state.symbols) buildHistory(sym);
  seedPrints();
  for (const sym of state.symbols) considerSignal(sym, true);
}

function stepSymbol(sym) {
  const prev = sym.price;
  const pull = (sym.target - prev) / (sym.tick * 500);
  const direction = Math.random() - 0.48 + pull >= 0 ? 1 : -1;
  const ticks = Math.random() < 0.82 ? 1 : randInt(2, 4);
  const price = roundTick(prev + direction * ticks * sym.tick, sym.tick);
  const size = Math.random() < 0.07
    ? randInt(sym.printMin, Math.round(sym.base * 1.4))
    : randInt(1, Math.max(4, Math.round(sym.base / 9)));
  const isBuy = price >= prev;
  sym.prev = prev;
  sym.price = price;
  sym.high = Math.max(sym.high, price);
  sym.low = Math.min(sym.low, price);
  sym.sessionVolume += size;
  sym.sessionDelta += isBuy ? size : -size;

  for (const tf of TIMEFRAMES) {
    const list = state.books[sym.id][tf];
    const ms = TF_MS[tf];
    let candle = list[list.length - 1];
    let guard = 0;
    while (state.simNow >= candle.t + ms && guard++ < 3) {
      candle = blankCandle(candle.t + ms, candle.c);
      list.push(candle);
      if (list.length > 220) list.shift();
    }
    addTrade(candle, price, size, isBuy);
  }

  if (size >= sym.printMin) {
    state.prints.unshift({
      id: `${sym.id}-${state.simNow}-${size}`,
      sym: sym.id,
      price,
      size,
      isBuy,
      t: state.simNow,
    });
    if (state.prints.length > 60) state.prints.length = 60;
  }
}

function candleSeries(sym, tf) {
  return state.books[sym.id][tf];
}

function considerSignal(sym, force) {
  const now = Date.now();
  if (!force && now - (state.signalAt[sym.id] || 0) < 9000) return;
  const list = candleSeries(sym, state.timeframe);
  if (!list || list.length < 4) return;
  const candle = list[list.length - 1];
  const prev = list.slice(-4, -1);
  if (candle.v < 8) return;
  const ratio = candle.askV / Math.max(1, candle.bidV);
  const rangeTicks = Math.max(1, Math.round((candle.h - candle.l) / sym.tick));
  let signal = null;
  if (candle.v > sym.base * 0.35 && rangeTicks <= 6) {
    signal = {
      kind: "absorption",
      side: "Watch",
      title: "Absorption",
      text: `${fmtSize(candle.v)} contracts traded inside ${rangeTicks} ticks at ${fmt(sym, candle.c)}.`,
    };
  } else if (ratio >= 2.6 || ratio <= 0.38) {
    const buyers = ratio >= 1;
    signal = {
      kind: "imbalance",
      side: buyers ? "Long" : "Short",
      title: "Imbalance",
      text: `${buyers ? "Buyers" : "Sellers"} lifted ${Math.max(ratio, 1 / ratio).toFixed(1)}× the other side. Delta ${fmtSize(candle.delta)}.`,
    };
  } else if (prev.every((item) => item.delta > 0) && candle.delta > 0) {
    signal = {
      kind: "stacked",
      side: "Long",
      title: "Stacked imbalance",
      text: `Four straight positive-delta candles into ${fmt(sym, candle.c)}.`,
    };
  } else if (prev.every((item) => item.delta < 0) && candle.delta < 0) {
    signal = {
      kind: "stacked",
      side: "Short",
      title: "Stacked imbalance",
      text: `Four straight negative-delta candles into ${fmt(sym, candle.c)}.`,
    };
  } else if ((candle.c > candle.o && candle.delta < 0) || (candle.c < candle.o && candle.delta > 0)) {
    signal = {
      kind: "divergence",
      side: "Watch",
      title: "Delta divergence",
      text: candle.c >= candle.o
        ? `Price pushed up while delta stayed negative at ${fmt(sym, candle.c)}.`
        : `Price pushed down while delta stayed positive at ${fmt(sym, candle.c)}.`,
    };
  }
  if (!signal) return;
  state.signalAt[sym.id] = now;
  state.signals.unshift({
    id: `${sym.id}-${now}`,
    sym: sym.id,
    price: candle.c,
    t: state.simNow,
    ...signal,
  });
  if (state.signals.length > 40) state.signals.length = 40;
}

function tick() {
  state.simNow += 2800;
  for (const sym of state.symbols) stepSymbol(sym);
  considerSignal(current(), false);
  paintLive();
}

function loadStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (saved.settings) state.settings = { ...state.settings, ...saved.settings };
    if (Array.isArray(saved.journal)) state.journal = saved.journal;
  } catch {
    /* keep defaults */
  }
}

function saveStore() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    settings: state.settings,
    journal: state.journal,
  }));
}

function applySettings() {
  document.body.classList.toggle("compact", state.settings.compact);
  $("set-volume").checked = state.settings.showVolume;
  $("set-compact").checked = state.settings.compact;
  $("set-speed").value = String(state.settings.speed);
  $("set-speed-label").textContent = SPEED_LABEL[state.settings.speed];
  clearInterval(state.timer);
  state.timer = setInterval(tick, SPEED_MS[state.settings.speed]);
}

function flash(el, direction) {
  if (!el) return;
  el.classList.remove("flash-up", "flash-down");
  if (!direction) return;
  void el.offsetWidth;
  el.classList.add(direction > 0 ? "flash-up" : "flash-down");
}

function setText(el, text, direction) {
  if (!el || el.textContent === text) return;
  el.textContent = text;
  flash(el, direction);
}

function renderWatch(rebuild) {
  const list = $("watchlist");
  if (rebuild || !list.childElementCount) {
    list.innerHTML = state.symbols.map((sym) => `
      <button type="button" class="symbol" data-symbol="${sym.id}" id="row-${sym.id}" role="option">
        <div class="symbol-top"><span class="sid">${sym.id}</span><span class="px" id="px-${sym.id}"></span></div>
        <div class="symbol-bot"><span class="sname">${esc(sym.name)}</span><span class="pch" id="pch-${sym.id}"></span></div>
      </button>`).join("");
  }
  const query = state.watchQuery.trim().toLowerCase();
  let shown = 0;
  for (const sym of state.symbols) {
    const row = $(`row-${sym.id}`);
    const match = !query || sym.id.toLowerCase().includes(query) || sym.name.toLowerCase().includes(query);
    row.hidden = !match;
    if (match) shown += 1;
    row.classList.toggle("active", sym.id === state.symbol);
    const { delta, pct } = changeOf(sym);
    const moved = sym.price - sym.prev;
    setText($(`px-${sym.id}`), fmt(sym, sym.price), moved);
    const change = $(`pch-${sym.id}`);
    change.textContent = `${signed(sym, delta)}  ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    change.className = `pch ${dirClass(delta)}`;
  }
  $("watch-count").textContent = `${shown} contracts`;
}

function renderToolbar() {
  const tfs = $("tb-tfs");
  if (!tfs.childElementCount) {
    tfs.innerHTML = TIMEFRAMES.map((tf) => `<button type="button" data-tf="${tf}">${tf}</button>`).join("");
  }
  for (const button of tfs.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.tf === state.timeframe);
  }
  const sym = current();
  $("tb-symbol").textContent = sym.id;
  $("tb-name").textContent = sym.name;
  const moved = sym.price - sym.prev;
  setText($("tb-last"), fmt(sym, sym.price), moved);
  $("tb-last").className = `last ${dirClass(moved)}`;
  const { delta, pct } = changeOf(sym);
  const change = $("tb-chg");
  change.textContent = `${signed(sym, delta)} (${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%)`;
  change.className = `chg ${dirClass(delta)}`;
  $("tb-bid").textContent = fmt(sym, roundTick(sym.price - sym.tick, sym.tick));
  $("tb-ask").textContent = fmt(sym, sym.price);
  document.title = `${sym.id} ${fmt(sym, sym.price)} · Live Screener`;
}

function fitCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(10, Math.floor(width));
  const h = Math.max(10, Math.floor(height));
  if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function drawChart() {
  const canvas = $("chart");
  const wrap = $("chart-wrap");
  if (!canvas || wrap.clientWidth < 20 || state.view !== "room") return;
  const { ctx, w, h } = fitCanvas(canvas, wrap.clientWidth, wrap.clientHeight);
  const sym = current();
  const candles = candleSeries(sym, state.timeframe).slice(-90);
  const showVol = state.settings.showVolume;
  const volH = showVol ? Math.round(h * 0.18) : 0;
  const pad = { l: 8, r: 78, t: 14, b: 24 };
  const gap = showVol ? 10 : 0;
  const plotH = h - pad.t - pad.b - volH - gap;
  const plotW = w - pad.l - pad.r;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0c1016";
  ctx.fillRect(0, 0, w, h);
  if (!candles.length || plotW < 20 || plotH < 20) return;

  let min = Infinity;
  let max = -Infinity;
  let maxVol = 1;
  for (const candle of candles) {
    min = Math.min(min, candle.l);
    max = Math.max(max, candle.h);
    maxVol = Math.max(maxVol, candle.v);
  }
  const padPx = (max - min) * 0.08 || sym.tick * 8;
  min -= padPx;
  max += padPx;
  const yOf = (price) => pad.t + ((max - price) / (max - min)) * plotH;
  const slot = plotW / candles.length;

  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#667085";
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "left";
  for (let i = 0; i < 5; i += 1) {
    const price = max - ((max - min) * i) / 4;
    const y = Math.round(yOf(price)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(fmt(sym, price), w - pad.r + 8, y + 4);
  }

  candles.forEach((candle, index) => {
    const x = pad.l + index * slot + slot / 2;
    const up = candle.c >= candle.o;
    const color = up ? "#1fbf8f" : "#ff5c5c";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, yOf(candle.h));
    ctx.lineTo(Math.round(x) + 0.5, yOf(candle.l));
    ctx.stroke();
    const bodyTop = yOf(Math.max(candle.o, candle.c));
    const bodyBot = yOf(Math.min(candle.o, candle.c));
    const bodyH = Math.max(1, bodyBot - bodyTop);
    const bodyW = Math.max(1, Math.min(16, slot * 0.62));
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);
    if (showVol) {
      const vh = (candle.v / maxVol) * (volH - 4);
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x - bodyW / 2, h - pad.b - vh, bodyW, vh);
      ctx.globalAlpha = 1;
    }
  });

  const last = candles[candles.length - 1];
  const yLast = yOf(sym.price);
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = last.c >= last.o ? "#1fbf8f" : "#ff5c5c";
  ctx.beginPath();
  ctx.moveTo(pad.l, yLast);
  ctx.lineTo(w - pad.r, yLast);
  ctx.stroke();
  ctx.setLineDash([]);
  const label = fmt(sym, sym.price);
  const labelW = ctx.measureText(label).width + 12;
  ctx.fillStyle = last.c >= last.o ? "#1fbf8f" : "#ff5c5c";
  ctx.fillRect(w - pad.r + 4, yLast - 9, labelW, 18);
  ctx.fillStyle = "#08110e";
  ctx.fillText(label, w - pad.r + 10, yLast + 4);

  ctx.fillStyle = "#667085";
  ctx.textAlign = "center";
  [0, Math.floor(candles.length / 2), candles.length - 1].forEach((index) => {
    const candle = candles[index];
    if (!candle) return;
    ctx.fillText(fmtClock(candle.t, state.timeframe), pad.l + index * slot + slot / 2, h - 6);
  });

  if (state.hover != null) {
    const index = Math.max(0, Math.min(candles.length - 1, state.hover));
    const candle = candles[index];
    const x = pad.l + index * slot + slot / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
    const tip = $("tip");
    tip.hidden = false;
    tip.innerHTML = `${fmtClock(candle.t, state.timeframe)}<br>O ${fmt(sym, candle.o)} H ${fmt(sym, candle.h)}<br>L ${fmt(sym, candle.l)} C ${fmt(sym, candle.c)}<br>Vol ${fmtSize(candle.v)} Δ ${fmtSize(candle.delta)}`;
    const left = Math.min(w - 180, Math.max(8, x + 12));
    tip.style.left = `${left}px`;
    tip.style.top = "16px";
  } else {
    $("tip").hidden = true;
  }
}

function levelVolume(candle, from, to) {
  let bid = 0;
  let ask = 0;
  for (const level of Object.values(candle.levels)) {
    if (level.p >= from && level.p < to) {
      bid += level.bid;
      ask += level.ask;
    }
  }
  return { bid, ask, v: bid + ask };
}

function priceBuckets(candles, tick) {
  let min = Infinity;
  let max = -Infinity;
  for (const candle of candles) {
    min = Math.min(min, candle.l);
    max = Math.max(max, candle.h);
  }
  if (!Number.isFinite(min)) return { size: tick, rows: [] };
  const span = Math.max(tick, max - min);
  const steps = Math.max(1, Math.round(span / 12 / tick));
  const size = steps * tick;
  const start = Math.floor(min / size);
  const end = Math.ceil(max / size);
  const rows = [];
  for (let step = end; step >= start; step -= 1) rows.push(roundTick(step * size, tick));
  return { size, rows };
}

function drawProfile() {
  const canvas = $("profile");
  if (!canvas) return;
  const sym = current();
  const candles = candleSeries(sym, state.timeframe).slice(-40);
  const { ctx, w, h } = fitCanvas(canvas, canvas.clientWidth || 340, 168);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0c1016";
  ctx.fillRect(0, 0, w, h);
  const { size, rows } = priceBuckets(candles, sym.tick);
  if (!rows.length) return;
  const totals = rows.map((price) => {
    const vol = candles.reduce((sum, candle) => sum + levelVolume(candle, price, price + size).v, 0);
    return { price, vol };
  });
  const max = Math.max(1, ...totals.map((row) => row.vol));
  const poc = totals.reduce((best, row) => (row.vol > best.vol ? row : best), totals[0]);
  const rowH = h / totals.length;
  ctx.font = "11px ui-monospace, monospace";
  totals.forEach((row, index) => {
    const y = index * rowH;
    const width = 8 + (row.vol / max) * (w - 92);
    ctx.fillStyle = row.price === poc.price ? "rgba(224,177,90,0.85)" : "rgba(76,141,255,0.75)";
    ctx.fillRect(72, y + 2, width, Math.max(2, rowH - 3));
    ctx.fillStyle = "#9aa3b5";
    ctx.fillText(fmt(sym, row.price), 4, y + rowH * 0.72);
  });
}

function drawFlow() {
  const canvas = $("flow");
  if (!canvas) return;
  const sym = current();
  const candles = candleSeries(sym, state.timeframe).slice(-8);
  const { ctx, w, h } = fitCanvas(canvas, canvas.clientWidth || 340, canvas.clientHeight || 420);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0c1016";
  ctx.fillRect(0, 0, w, h);
  const { size, rows } = priceBuckets(candles, sym.tick);
  if (!rows.length) return;
  const axis = 64;
  const deltaH = 28;
  const headH = 22;
  const gridW = w - axis - 8;
  const gridH = h - headH - deltaH;
  const colW = gridW / candles.length;
  const rowH = gridH / rows.length;
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "#8b95a8";
  candles.forEach((candle, index) => {
    ctx.fillText(fmtClock(candle.t, state.timeframe), 8 + index * colW + colW / 2, 14);
  });
  let maxCell = 1;
  const cells = candles.map((candle) => rows.map((price) => {
    const vol = levelVolume(candle, price, price + size);
    maxCell = Math.max(maxCell, vol.v);
    return vol;
  }));
  rows.forEach((price, row) => {
    const y = headH + row * rowH;
    const near = Math.abs(price - sym.price) < size;
    if (near) {
      ctx.fillStyle = "rgba(76,141,255,0.08)";
      ctx.fillRect(8, y, gridW, rowH);
    }
    candles.forEach((_, index) => {
      const vol = cells[index][row];
      if (!vol.v) return;
      const x = 8 + index * colW;
      const alpha = 0.18 + (vol.v / maxCell) * 0.7;
      const buy = vol.ask >= vol.bid;
      ctx.fillStyle = buy ? `rgba(31,191,143,${alpha})` : `rgba(255,92,92,${alpha})`;
      ctx.fillRect(x + 1, y + 1, colW - 2, rowH - 2);
      if (rowH >= 16 && colW >= 42) {
        ctx.fillStyle = "#e7edf6";
        ctx.fillText(`${Math.round(vol.bid)}×${Math.round(vol.ask)}`, x + colW / 2, y + rowH * 0.68);
      }
    });
    ctx.fillStyle = "#8b95a8";
    ctx.textAlign = "right";
    ctx.fillText(fmt(sym, price), w - 4, y + rowH * 0.68);
    ctx.textAlign = "center";
  });
  candles.forEach((candle, index) => {
    const x = 8 + index * colW;
    ctx.fillStyle = candle.delta >= 0 ? "#1fbf8f" : "#ff5c5c";
    ctx.fillText(fmtSize(candle.delta), x + colW / 2, h - 8);
  });
}

function renderPrints(prints) {
  if (!prints.length) return `<div class="empty">Waiting for a large print.</div>`;
  return prints.slice(0, 18).map((print) => {
    const sym = state.symbols.find((item) => item.id === print.sym);
    return `<div class="print">
      <span class="side ${print.isBuy ? "buy" : "sell"}">${print.isBuy ? "BUY" : "SELL"}</span>
      <div><b>${print.sym}</b> ${fmt(sym, print.price)} <span class="meta">${fmtSize(print.size)}</span></div>
      <span class="meta">${fmtTime(print.t)}</span>
    </div>`;
  }).join("");
}

function renderSignals(signals) {
  if (!signals.length) return `<div class="empty">Signals appear when the active tape shows absorption, imbalance, or divergence.</div>`;
  return signals.slice(0, 8).map((signal) => `
    <article class="signal">
      <div>
        <div class="kind ${signal.kind}">${esc(signal.title)} · ${esc(signal.sym)}</div>
        <div>${esc(signal.text)}</div>
        <div class="meta">${fmtTime(signal.t)}</div>
      </div>
      <button type="button" class="linkish" data-log="${esc(signal.id)}">Log</button>
    </article>`).join("");
}

function renderScreenerTab() {
  const sym = current();
  const buy = Math.max(0, sym.sessionVolume / 2 + sym.sessionDelta / 2);
  const buyPct = sym.sessionVolume ? (buy / sym.sessionVolume) * 100 : 50;
  const mine = state.signals.filter((signal) => signal.sym === sym.id);
  return `
    <div class="stat-row">
      <div class="stat"><span>Volume</span><b id="st-vol">${fmtSize(sym.sessionVolume)}</b></div>
      <div class="stat"><span>Delta</span><b id="st-delta" class="${dirClass(sym.sessionDelta)}">${fmtSize(sym.sessionDelta)}</b></div>
      <div class="stat"><span>Buy %</span><b id="st-buy">${buyPct.toFixed(1)}%</b></div>
    </div>
    <div>
      <h3 class="block-title">Volume profile <span>${sym.id}</span></h3>
      <canvas id="profile" class="profile-canvas"></canvas>
    </div>
    <div>
      <h3 class="block-title">Signals</h3>
      <div class="signals" id="signal-list">${renderSignals(mine)}</div>
    </div>
    <div>
      <h3 class="block-title">Large prints <span>Room</span></h3>
      <div class="prints" id="print-list">${renderPrints(state.prints)}</div>
    </div>`;
}

function ladderSize(sym, step) {
  if (!sym.ladder) sym.ladder = {};
  const key = String(step);
  if (sym.ladder[key] == null || Math.random() < 0.12) {
    const distance = Math.abs(step);
    const next = Math.max(1, Math.round((sym.base / 7) * Math.exp(-distance / 6) * (0.8 + Math.random() * 0.45)));
    sym.ladder[key] = sym.ladder[key] == null ? next : Math.round(sym.ladder[key] * 0.65 + next * 0.35);
  }
  return sym.ladder[key];
}

function samePrice(sym, a, b) {
  return Math.abs(a - b) < sym.tick / 2;
}

function renderDom() {
  const sym = current();
  const levels = [];
  for (let step = 14; step >= -14; step -= 1) {
    if (step === 0) continue;
    const price = roundTick(sym.price + step * sym.tick, sym.tick);
    levels.push({ price, size: ladderSize(sym, step), side: step > 0 ? "ask" : "bid" });
  }
  const max = Math.max(...levels.map((level) => level.size));
  const rows = [];
  const asks = levels.filter((level) => level.side === "ask");
  const bids = levels.filter((level) => level.side === "bid");
  const row = (level) => {
    const width = Math.max(8, (level.size / max) * 100);
    const working = state.working && state.working.sym === sym.id && samePrice(sym, state.working.price, level.price);
    const bid = level.side === "bid" ? `<span>${fmtSize(level.size)}</span><i class="bar" style="width:${width}%"></i>` : "";
    const ask = level.side === "ask" ? `<span>${fmtSize(level.size)}</span><i class="bar" style="width:${width}%"></i>` : "";
    return `<button type="button" class="ladder-row ${working ? "working" : ""}" data-dom-price="${level.price}" data-dom-side="${level.side}">
      <span class="bid-cell">${bid}</span>
      <span class="px-cell">${fmt(sym, level.price)}</span>
      <span class="ask-cell">${ask}</span>
    </button>`;
  };
  asks.forEach((level) => rows.push(row(level)));
  rows.push(`<div class="ladder-mid">${fmt(sym, sym.price)}</div>`);
  bids.forEach((level) => rows.push(row(level)));
  const working = state.working && state.working.sym === sym.id
    ? `Working ${state.working.side} ${fmt(sym, state.working.price)}`
    : "Click a price to rest a simulated order";
  return `<p class="hint" id="dom-hint">${esc(working)}</p><div class="ladder" id="ladder">${rows.join("")}</div>`;
}

function renderDock(force) {
  const body = $("dock-body");
  const stamp = `${state.tab}|${state.symbol}|${state.timeframe}`;
  const stale = body.dataset.stamp !== stamp;
  if (state.tab === "flow") {
    if (force || stale || !$("flow")) {
      body.innerHTML = `<h3 class="block-title">Footprint <span>${state.symbol} ${state.timeframe}</span></h3><canvas id="flow" class="flow-canvas"></canvas><p class="hint">Each cell is bid × ask inside that candle. Green is buy aggression, red is sell aggression.</p>`;
    }
    body.dataset.stamp = stamp;
    drawFlow();
    return;
  }
  if (state.tab === "dom") {
    const scroll = body.scrollTop;
    body.innerHTML = renderDom();
    body.scrollTop = scroll;
    body.dataset.stamp = stamp;
    return;
  }
  if (force || stale || !$("profile")) {
    body.dataset.stamp = stamp;
    body.innerHTML = renderScreenerTab();
  } else {
    const sym = current();
    const buy = Math.max(0, sym.sessionVolume / 2 + sym.sessionDelta / 2);
    const buyPct = sym.sessionVolume ? (buy / sym.sessionVolume) * 100 : 50;
    $("st-vol").textContent = fmtSize(sym.sessionVolume);
    const delta = $("st-delta");
    delta.textContent = fmtSize(sym.sessionDelta);
    delta.className = dirClass(sym.sessionDelta);
    $("st-buy").textContent = `${buyPct.toFixed(1)}%`;
    $("signal-list").innerHTML = renderSignals(state.signals.filter((signal) => signal.sym === sym.id));
    $("print-list").innerHTML = renderPrints(state.prints);
  }
  drawProfile();
}

function screenRows() {
  const query = state.query.trim().toLowerCase();
  let rows = state.symbols.filter((sym) => {
    const groupOk = state.group === "All" || sym.group === state.group;
    const text = `${sym.id} ${sym.name}`.toLowerCase();
    return groupOk && (!query || text.includes(query));
  });
  const { key, dir } = state.sort;
  rows.sort((a, b) => {
    const av = key === "pct" ? changeOf(a).pct : key === "range" ? a.high - a.low : a[key];
    const bv = key === "pct" ? changeOf(b).pct : key === "range" ? b.high - b.low : b[key];
    if (typeof av === "string") return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
  return rows;
}

function renderScreenerPage() {
  const chips = $("group-chips");
  if (!chips.childElementCount) {
    chips.innerHTML = GROUPS.map((group) => `<button type="button" data-group="${group}">${group}</button>`).join("");
  }
  for (const button of chips.querySelectorAll("button")) {
    button.classList.toggle("active", button.dataset.group === state.group);
  }
  const columns = [
    ["id", "Symbol"],
    ["name", "Name"],
    ["price", "Last"],
    ["delta", "Change"],
    ["pct", "Change %"],
    ["sessionVolume", "Volume"],
    ["sessionDelta", "Delta"],
    ["high", "High"],
    ["low", "Low"],
    ["range", "Range"],
  ];
  $("screen-table").querySelector("thead").innerHTML = `<tr>${columns.map(([key, label]) => {
    const mark = state.sort.key === key ? (state.sort.dir > 0 ? " ↑" : " ↓") : "";
    return `<th data-sort="${key}">${label}${mark}</th>`;
  }).join("")}</tr>`;
  $("screen-table").querySelector("tbody").innerHTML = screenRows().map((sym) => {
    const { delta, pct } = changeOf(sym);
    return `<tr data-symbol="${sym.id}">
      <td>${sym.id}</td>
      <td>${esc(sym.name)}</td>
      <td class="num">${fmt(sym, sym.price)}</td>
      <td class="num ${dirClass(delta)}">${signed(sym, delta)}</td>
      <td class="num ${dirClass(delta)}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</td>
      <td class="num">${fmtSize(sym.sessionVolume)}</td>
      <td class="num ${dirClass(sym.sessionDelta)}">${fmtSize(sym.sessionDelta)}</td>
      <td class="num">${fmt(sym, sym.high)}</td>
      <td class="num">${fmt(sym, sym.low)}</td>
      <td class="num">${fmt(sym, sym.high - sym.low)}</td>
    </tr>`;
  }).join("");
}

function renderAnalytics() {
  const symbols = state.symbols;
  const volume = symbols.reduce((sum, sym) => sum + sym.sessionVolume, 0);
  const delta = symbols.reduce((sum, sym) => sum + sym.sessionDelta, 0);
  const busiest = symbols.reduce((best, sym) => (sym.sessionVolume > best.sessionVolume ? sym : best), symbols[0]);
  const widest = symbols.reduce((best, sym) => {
    const range = (sym.high - sym.low) / sym.sessionOpen;
    const bestRange = (best.high - best.low) / best.sessionOpen;
    return range > bestRange ? sym : best;
  }, symbols[0]);
  $("analytics-cards").innerHTML = `
    <div class="stat"><span>Room volume</span><b>${fmtSize(volume)}</b></div>
    <div class="stat"><span>Net delta</span><b class="${dirClass(delta)}">${fmtSize(delta)}</b></div>
    <div class="stat"><span>Busiest</span><b>${busiest.id}</b></div>
    <div class="stat"><span>Widest range</span><b>${widest.id}</b></div>`;
  const canvas = $("analytics-chart");
  const { ctx, w, h } = fitCanvas(canvas, canvas.clientWidth || 800, 280);
  ctx.clearRect(0, 0, w, h);
  const max = Math.max(...symbols.map((sym) => sym.sessionVolume), 1);
  const slot = w / symbols.length;
  ctx.font = "12px ui-sans-serif, system-ui";
  ctx.textAlign = "center";
  symbols.forEach((sym, index) => {
    const barH = (sym.sessionVolume / max) * (h - 36);
    const x = index * slot + slot * 0.2;
    ctx.fillStyle = sym.sessionDelta >= 0 ? "#1fbf8f" : "#ff5c5c";
    ctx.fillRect(x, h - 22 - barH, slot * 0.6, barH);
    ctx.fillStyle = "#9aa3b5";
    ctx.fillText(sym.id, index * slot + slot / 2, h - 6);
  });
}

function renderJournal() {
  const select = $("j-symbol");
  const editing = document.activeElement && $("journal-form").contains(document.activeElement);
  if (!select.childElementCount) {
    select.innerHTML = state.symbols.map((sym) => `<option value="${sym.id}">${sym.id}</option>`).join("");
  }
  if (!editing) {
    select.value = state.symbol;
    $("j-price").value = fmt(current(), current().price);
  }
  const list = $("journal-list");
  if (!state.journal.length) {
    list.innerHTML = `<div class="empty">No notes yet. Log a signal from the room, or add one from the form.</div>`;
    return;
  }
  list.innerHTML = state.journal.map((entry) => `
    <article class="entry">
      <div>
        <strong>${esc(entry.side)} ${esc(entry.symbol)}</strong> <span class="num">${esc(entry.price)}</span>
        <div>${esc(entry.note)}</div>
        <div class="meta">${fmtTime(entry.t)}</div>
      </div>
      <button type="button" class="linkish" data-drop-journal="${esc(entry.id)}">Remove</button>
    </article>`).join("");
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 1800);
}

function setView(view) {
  const allowed = ["room", "screener", "analytics", "journal", "settings"];
  state.view = allowed.includes(view) ? view : "room";
  for (const panel of document.querySelectorAll("[data-view-panel]")) {
    panel.hidden = panel.dataset.viewPanel !== state.view;
  }
  for (const button of document.querySelectorAll("[data-nav]")) {
    button.classList.toggle("active", button.dataset.nav === state.view);
  }
  if (location.hash !== `#${state.view}`) history.replaceState(null, "", `#${state.view}`);
  if (state.view === "journal") renderJournal();
  paintLive();
}

function selectSymbol(id) {
  if (!state.symbols.some((sym) => sym.id === id)) return;
  state.symbol = id;
  state.hover = null;
  if (state.view !== "room") setView("room");
  else paintLive();
}

function paintLive() {
  renderWatch(false);
  renderToolbar();
  if (state.view === "room") {
    drawChart();
    renderDock(false);
  } else if (state.view === "screener") renderScreenerPage();
  else if (state.view === "analytics") renderAnalytics();
}

function logSignal(id) {
  const signal = state.signals.find((item) => item.id === id);
  if (!signal) return;
  state.journal.unshift({
    id: `j-${Date.now()}`,
    symbol: signal.sym,
    side: signal.side || "Watch",
    price: fmt(state.symbols.find((sym) => sym.id === signal.sym), signal.price),
    note: `${signal.title}: ${signal.text}`,
    t: Date.now(),
  });
  saveStore();
  toast(`Logged ${signal.sym} ${signal.title.toLowerCase()}`);
}

function bind() {
  document.body.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-nav]");
    if (nav) {
      event.preventDefault();
      setView(nav.dataset.nav);
      return;
    }
    const tf = event.target.closest("[data-tf]");
    if (tf) {
      state.timeframe = tf.dataset.tf;
      state.hover = null;
      renderDock(true);
      paintLive();
      return;
    }
    const tab = event.target.closest("[data-tab]");
    if (tab) {
      state.tab = tab.dataset.tab;
      for (const button of document.querySelectorAll("[data-tab]")) {
        button.classList.toggle("active", button.dataset.tab === state.tab);
      }
      renderDock(true);
      return;
    }
    const symbol = event.target.closest("[data-symbol]");
    if (symbol && !event.target.closest("[data-log], [data-drop-journal]")) {
      selectSymbol(symbol.dataset.symbol);
      return;
    }
    const group = event.target.closest("[data-group]");
    if (group) {
      state.group = group.dataset.group;
      renderScreenerPage();
      return;
    }
    const sort = event.target.closest("[data-sort]");
    if (sort) {
      const key = sort.dataset.sort;
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
      renderScreenerPage();
      return;
    }
    const log = event.target.closest("[data-log]");
    if (log) {
      logSignal(log.dataset.log);
      return;
    }
    const drop = event.target.closest("[data-drop-journal]");
    if (drop) {
      state.journal = state.journal.filter((entry) => entry.id !== drop.dataset.dropJournal);
      saveStore();
      renderJournal();
      return;
    }
    const level = event.target.closest("[data-dom-price]");
    if (level) {
      const sym = current();
      const price = roundTick(Number(level.dataset.domPrice), sym.tick);
      const side = level.dataset.domSide === "bid" ? "bid" : "ask";
      if (state.working && state.working.sym === sym.id && samePrice(sym, state.working.price, price)) state.working = null;
      else state.working = { sym: sym.id, price, side };
      renderDock(true);
    }
  });

  $("watch-filter").addEventListener("input", (event) => {
    state.watchQuery = event.target.value;
    renderWatch(false);
  });
  $("screen-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    renderScreenerPage();
  });
  $("chart-wrap").addEventListener("mousemove", (event) => {
    const rect = $("chart-wrap").getBoundingClientRect();
    const candles = candleSeries(current(), state.timeframe).slice(-90);
    const plotW = rect.width - 8 - 78;
    const slot = plotW / candles.length;
    state.hover = Math.floor((event.clientX - rect.left - 8) / slot);
    drawChart();
  });
  $("chart-wrap").addEventListener("mouseleave", () => {
    state.hover = null;
    drawChart();
  });
  $("journal-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const note = $("j-note").value.trim();
    const price = $("j-price").value.trim();
    if (!note || !price) return;
    state.journal.unshift({
      id: `j-${Date.now()}`,
      symbol: $("j-symbol").value,
      side: $("j-side").value,
      price,
      note,
      t: Date.now(),
    });
    $("j-note").value = "";
    saveStore();
    renderJournal();
    toast("Journal entry saved");
  });
  $("set-speed").addEventListener("input", (event) => {
    state.settings.speed = Number(event.target.value);
    saveStore();
    applySettings();
  });
  $("set-volume").addEventListener("change", (event) => {
    state.settings.showVolume = event.target.checked;
    saveStore();
    drawChart();
  });
  $("set-compact").addEventListener("change", (event) => {
    state.settings.compact = event.target.checked;
    saveStore();
    applySettings();
  });
  $("set-reset").addEventListener("click", () => {
    initMarket();
    renderWatch(true);
    renderDock(true);
    paintLive();
    toast("Session reset");
  });
  $("set-clear").addEventListener("click", () => {
    state.journal = [];
    saveStore();
    renderJournal();
    toast("Journal cleared");
  });
  window.addEventListener("resize", () => paintLive());
  window.addEventListener("hashchange", () => setView(location.hash.slice(1)));
}

loadStore();
initMarket();
bind();
applySettings();
renderWatch(true);
setView(location.hash.slice(1) || "room");
renderDock(true);
