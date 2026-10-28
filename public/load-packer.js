/**
 * Load Packer — 3D carton → pallet / container packing engine (ES module).
 * Shared by the browser (public/load-planner.html) and Node (controllers/load-planner-agent.mjs).
 *
 * Coordinates are centimetres: x = length (0 = front wall / nose, grows toward the doors),
 * y = width, z = height. Weights are kilograms.
 *
 * Algorithm: extreme-point first-fit. Cartons are expanded to units, sorted by a strategy,
 * and each one goes to the first extreme point (ordered back → bottom → side) where an
 * allowed orientation fits inside the space, overlaps nothing, is ≥ SUPPORT of its base
 * supported by stackable cartons, and keeps the space within its payload. optimise() runs
 * every strategy and keeps the plan with the fewest spaces, then the fullest.
 */

export const CONTAINERS = {
  '20GP': { code: '20GP', name: "20ft Standard",  L: 589,  W: 235, H: 239, maxKg: 28200, tareKg: 2300 },
  '40GP': { code: '40GP', name: "40ft Standard",  L: 1203, W: 235, H: 239, maxKg: 26700, tareKg: 3750 },
  '40HC': { code: '40HC', name: "40ft High Cube", L: 1203, W: 235, H: 269, maxKg: 26500, tareKg: 3900 },
};

// maxH is the overall pallet height including the deck (opts.palletMaxH overrides it).
// Small pallets default to ~1.15 m so two stack inside a 2.39 m container (2.69 m HC).
export const PALLETS = {
  EUR:   { code: 'EUR',   name: 'EUR 1200×800',          L: 120,   W: 80,    deckH: 14.4, maxH: 180, maxKg: 1500, tareKg: 25 },
  STD:   { code: 'STD',   name: 'Standard 1200×1000',    L: 120,   W: 100,   deckH: 15,   maxH: 180, maxKg: 1500, tareKg: 30 },
  US:    { code: 'US',    name: 'US 48×40 in',           L: 121.9, W: 101.6, deckH: 14.4, maxH: 180, maxKg: 1300, tareKg: 25 },
  HSTD:  { code: 'HSTD',  name: 'Half Standard 1000×600', L: 100,  W: 60,    deckH: 14.4, maxH: 115, maxKg: 600,  tareKg: 12 },
  HALF:  { code: 'HALF',  name: 'Half EUR 800×600',      L: 80,    W: 60,    deckH: 14.4, maxH: 115, maxKg: 500,  tareKg: 10 },
  QTR:   { code: 'QTR',   name: 'Quarter EUR 600×400',   L: 60,    W: 40,    deckH: 14.4, maxH: 100, maxKg: 250,  tareKg: 5 },
};

/** Tallest pallet (incl. deck) that still stacks n-high in a container, with handling clearance. */
export function stackHeight(containerH, n = 2, clearance = 5) {
  return Math.floor((containerH - clearance) / n);
}

const EPS = 0.01;
const SUPPORT = 0.75;            // share of a carton's base that must rest on something
const MAX_UNITS = 5000;
const MAX_SPACES = 200;

export const STRATEGIES = [
  { key: 'volume',  label: 'Largest volume first',  sort: (a, b) => b.vol - a.vol || b.h - a.h },
  { key: 'base',    label: 'Largest base first',    sort: (a, b) => b.l * b.w - a.l * a.w || b.h - a.h },
  { key: 'height',  label: 'Tallest first',         sort: (a, b) => b.h - a.h || b.vol - a.vol },
  { key: 'weight',  label: 'Heaviest first',        sort: (a, b) => b.kg - a.kg || b.vol - a.vol },
  { key: 'longest', label: 'Longest side first',    sort: (a, b) => Math.max(b.l, b.w, b.h) - Math.max(a.l, a.w, a.h) || b.vol - a.vol },
];
// Orientation preference: flat (lowest height) first, least depth first (tighter walls), or flat with
// the long side along the length (tiles exact-fit decks, e.g. 40×30 cartons 2×2 on an 80×60 half pallet).
const ORIENT_PREFS = [
  { key: 'flat', label: 'flat turns',  sort: (a, b) => a[2] - b[2] || a[0] - b[0] },
  { key: 'wall', label: 'tight walls', sort: (a, b) => a[0] - b[0] || a[2] - b[2] },
  { key: 'long', label: 'long side along length', sort: (a, b) => a[2] - b[2] || b[0] - a[0] },
];

/** Allowed (l, w, h) turns. Upright cartons only spin on the floor; others may be turned over. */
export function orientations(l, w, h, canTurn) {
  const all = canTurn
    ? [[l, w, h], [w, l, h], [l, h, w], [h, l, w], [w, h, l], [h, w, l]]
    : [[l, w, h], [w, l, h]];
  const seen = new Set();
  return all.filter(o => { const k = o.join('x'); if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * Expand item lines to carton units.
 * item: { key, code, name, ref, l, w, h, kg (per carton), cartons, stackable, canTurn, color }
 */
export function expandUnits(items) {
  const units = [];
  for (const it of items) {
    const n = Math.max(0, Math.floor(Number(it.cartons) || 0));
    const l = +it.l, w = +it.w, h = +it.h;
    if (!(l > 0 && w > 0 && h > 0) || !n) continue;
    for (let i = 0; i < n; i++) {
      units.push({ key: it.key, code: it.code, name: it.name, ref: it.ref || '', color: it.color,
        l, w, h, kg: +it.kg || 0, vol: l * w * h, stackable: it.stackable !== false, canTurn: !!it.canTurn,
        // Pallet units carry their own load, drawn on top of them.
        pallet: it.pallet ?? null });
      if (units.length > MAX_UNITS) throw new Error(`Too many cartons (over ${MAX_UNITS}). Simulate fewer orders at a time.`);
    }
  }
  return units;
}

// ── One space (container or pallet) ───────────────────────────────────────────
class Space {
  constructor(dims, maxKg) {
    this.L = dims.L; this.W = dims.W; this.H = dims.H; this.maxKg = maxKg;
    this.boxes = []; this.kg = 0; this.vol = 0;
    this.points = [{ x: 0, y: 0, z: 0, id: 0 }]; this.nextId = 1;
    this.failed = new Map();     // shape key → ids of points already known not to fit it
    this.pointKeys = new Set(['0|0|0']);
  }

  overlaps(x, y, z, l, w, h) {
    for (const b of this.boxes) {
      if (x < b.x + b.l - EPS && x + l > b.x + EPS &&
          y < b.y + b.w - EPS && y + w > b.y + EPS &&
          z < b.z + b.h - EPS && z + h > b.z + EPS) return true;
    }
    return false;
  }

  supported(x, y, z, l, w) {
    if (z < EPS) return true;
    let area = 0;
    for (const b of this.boxes) {
      if (Math.abs(b.z + b.h - z) > EPS) continue;
      const ox = Math.min(x + l, b.x + b.l) - Math.max(x, b.x);
      const oy = Math.min(y + w, b.y + b.w) - Math.max(y, b.y);
      if (ox <= EPS || oy <= EPS) continue;
      if (!b.stackable) return false;
      area += ox * oy;
    }
    return area >= SUPPORT * l * w - EPS;
  }

  fits(p, l, w, h, kg, hLimit) {
    return p.x + l <= this.L + EPS && p.y + w <= this.W + EPS && p.z + h <= hLimit + EPS &&
      this.kg + kg <= this.maxKg + EPS &&
      !this.overlaps(p.x, p.y, p.z, l, w, h) && this.supported(p.x, p.y, p.z, l, w);
  }

  tryPlace(u, orients, hLimit = this.H) {
    const shape = `${u.key}|${u.l}x${u.w}x${u.h}|${u.canTurn}|${hLimit}`;
    let failed = this.failed.get(shape);
    if (!failed) this.failed.set(shape, failed = new Set());
    for (const p of this.points) {
      if (failed.has(p.id)) continue;
      for (const [l, w, h] of orients) {
        if (this.fits(p, l, w, h, u.kg, hLimit)) { this.place(u, p, l, w, h); return true; }
      }
      failed.add(p.id);
    }
    return false;
  }

  place(u, p, l, w, h) {
    const b = { ...u, x: p.x, y: p.y, z: p.z, l, w, h, seq: this.boxes.length + 1 };
    this.boxes.push(b);
    this.kg += u.kg; this.vol += l * w * h;
    this.points = this.points.filter(q => q !== p &&
      !(q.x >= b.x - EPS && q.x < b.x + l - EPS && q.y >= b.y - EPS && q.y < b.y + w - EPS && q.z >= b.z - EPS && q.z < b.z + h - EPS));
    const add = (x, y, z) => {
      if (x >= this.L - EPS || y >= this.W - EPS || z >= this.H - EPS) return;
      const k = `${x.toFixed(2)}|${y.toFixed(2)}|${z.toFixed(2)}`;
      if (this.pointKeys.has(k)) return;
      this.pointKeys.add(k);
      this.points.push({ x, y, z, id: this.nextId++ });
    };
    for (const [x, y, z] of [[b.x + l, b.y, b.z], [b.x, b.y + w, b.z], [b.x, b.y, b.z + h]]) {
      add(x, y, z);
      add(x, y, this.dropZ(x, y, z));
      add(this.dropX(x, y, z), y, z);
      add(x, this.dropY(x, y, z), z);
    }
    // Back → bottom → side: build walls from the nose toward the doors.
    this.points.sort((a, c) => a.x - c.x || a.z - c.z || a.y - c.y);
  }

  dropZ(x, y, z) {
    let top = 0;
    for (const b of this.boxes) {
      if (x >= b.x - EPS && x < b.x + b.l - EPS && y >= b.y - EPS && y < b.y + b.w - EPS && b.z + b.h <= z + EPS) top = Math.max(top, b.z + b.h);
    }
    return top;
  }
  dropX(x, y, z) {
    let edge = 0;
    for (const b of this.boxes) {
      if (y >= b.y - EPS && y < b.y + b.w - EPS && z >= b.z - EPS && z < b.z + b.h - EPS && b.x + b.l <= x + EPS) edge = Math.max(edge, b.x + b.l);
    }
    return edge;
  }
  dropY(x, y, z) {
    let edge = 0;
    for (const b of this.boxes) {
      if (x >= b.x - EPS && x < b.x + b.l - EPS && z >= b.z - EPS && z < b.z + b.h - EPS && b.y + b.w <= y + EPS) edge = Math.max(edge, b.y + b.w);
    }
    return edge;
  }
}

/** Pack units into as many identical spaces as needed with one strategy. */
// Non-stackable handling: 'first' (as sorted), 'last' (after the rest, so they land on top),
// 'top' (last, and stackable cartons stop short of the roof to leave a tier for them).
const FRAGILE_MODES = { first: '', last: ' · non-stackable last', top: ' · non-stackable top tier' };

export function packOnce(units, dims, maxKg, strategy = STRATEGIES[0], orientPref = ORIENT_PREFS[0], fragile = 'first') {
  let queue = [...units].sort((a, b) => (fragile !== 'first' ? (a.stackable ? 0 : 1) - (b.stackable ? 0 : 1) : 0) || strategy.sort(a, b));
  const reserve = fragile === 'top' ? Math.max(0, ...units.filter(u => !u.stackable).map(u => Math.min(u.l, u.w, u.h, u.canTurn ? Infinity : u.h))) : 0;
  const capped = reserve > 0 && reserve < dims.H ? dims.H - reserve : dims.H;
  const spaces = [], unpacked = [];
  while (queue.length && spaces.length < MAX_SPACES) {
    const s = new Space(dims, maxKg);
    const left = [];
    for (const u of queue) {
      const orients = orientations(u.l, u.w, u.h, u.canTurn).sort(orientPref.sort);
      if (!s.tryPlace(u, orients, u.stackable ? capped : dims.H)) left.push(u);
    }
    if (!s.boxes.length) { unpacked.push(...left); queue = []; break; }   // nothing fits an empty space
    spaces.push(s);
    queue = left;
  }
  unpacked.push(...queue);
  return { spaces, unpacked,
    strategy: `${strategy.label} · ${orientPref.label}${FRAGILE_MODES[fragile]}` };
}

function score(r, dims) {
  const cap = dims.L * dims.W * dims.H;
  const packedVol = r.spaces.reduce((s, x) => s + x.vol, 0);
  return { unpacked: r.unpacked.length, spaces: r.spaces.length, fill: packedVol / (cap * Math.max(1, r.spaces.length)),
    // Pack the earlier spaces fuller so the last one is the light, partial load.
    firstFill: r.spaces[0] ? r.spaces[0].vol / cap : 0 };
}
const better = (a, b) =>
  a.unpacked !== b.unpacked ? a.unpacked < b.unpacked :
  a.spaces !== b.spaces ? a.spaces < b.spaces :
  Math.abs(a.fill - b.fill) > 1e-6 ? a.fill > b.fill : a.firstFill > b.firstFill;

/** Try every strategy × orientation preference; keep the best plan. */
export function optimise(units, dims, maxKg) {
  let best = null, bestScore = null;
  const tried = [];
  const anyFragile = units.some(u => !u.stackable) && units.some(u => u.stackable);
  for (const st of STRATEGIES) {
    for (const op of ORIENT_PREFS) for (const fl of anyFragile ? Object.keys(FRAGILE_MODES) : ['first']) {
      const r = packOnce(units, dims, maxKg, st, op, fl);
      const sc = score(r, dims);
      tried.push({ strategy: r.strategy, spaces: sc.spaces, unpacked: sc.unpacked, fill: +(sc.fill * 100).toFixed(1) });
      if (!best || better(sc, bestScore)) { best = r; bestScore = sc; }
    }
  }
  return { ...best, tried };
}

const summarise = (s, dims, tareKg = 0) => {
  const cap = dims.L * dims.W * dims.H;
  const usedH = s.boxes.reduce((m, b) => Math.max(m, b.z + b.h), 0);
  const usedL = s.boxes.reduce((m, b) => Math.max(m, b.x + b.l), 0);
  // Centre of gravity, as an offset from the floor centre in % of length / width.
  let cx = 0, cy = 0, cz = 0;
  const kg = s.kg || 1;
  for (const b of s.boxes) { cx += (b.x + b.l / 2) * b.kg; cy += (b.y + b.w / 2) * b.kg; cz += (b.z + b.h / 2) * b.kg; }
  return {
    boxes: s.boxes.map(b => ({ key: b.key, code: b.code, name: b.name, ref: b.ref, color: b.color, x: b.x, y: b.y, z: b.z,
      l: b.l, w: b.w, h: b.h, kg: b.kg, seq: b.seq, stackable: b.stackable, pallet: b.pallet })),
    count: s.boxes.length, kg: +s.kg.toFixed(1), grossKg: +(s.kg + tareKg).toFixed(1),
    volM3: +(s.vol / 1e6).toFixed(3), capM3: +(cap / 1e6).toFixed(3),
    fillPct: +(s.vol / cap * 100).toFixed(1), weightPct: +(s.kg / s.maxKg * 100).toFixed(1),
    usedH: +usedH.toFixed(1), usedL: +usedL.toFixed(1),
    cog: s.kg ? { x: +((cx / kg - dims.L / 2) / dims.L * 100).toFixed(1), y: +((cy / kg - dims.W / 2) / dims.W * 100).toFixed(1), z: +(cz / kg).toFixed(1) } : null,
  };
};

const unpackedSummary = units => {
  const m = new Map();
  for (const u of units) {
    const k = u.key;
    if (!m.has(k)) m.set(k, { key: k, code: u.code, name: u.name, ref: u.ref, cartons: 0, reason: '' });
    m.get(k).cartons++;
  }
  return [...m.values()];
};

/**
 * Full simulation.
 * opts: { mode: 'container' | 'pallet' | 'palletised', container: '40HC', pallet: 'EUR',
 *         palletStack: false (allow pallets on pallets), palletMaxH: cm incl. deck (default: the pallet's maxH) }
 */
export function simulate(items, opts = {}) {
  const t0 = Date.now();
  const mode = opts.mode || 'container';
  const units = expandUnits(items);
  if (!units.length) throw new Error('No cartons to load — check quantities and dimensions.');
  const out = { mode, cartons: units.length, totalKg: +units.reduce((s, u) => s + u.kg, 0).toFixed(1),
    totalM3: +(units.reduce((s, u) => s + u.vol, 0) / 1e6).toFixed(3) };

  let pallets = null;
  if (mode === 'pallet' || mode === 'palletised') {
    const base = PALLETS[opts.pallet] || PALLETS.EUR;
    const maxH = +opts.palletMaxH > base.deckH + 5 ? Math.min(+opts.palletMaxH, 300) : base.maxH;
    const p = maxH === base.maxH ? base : { ...base, maxH, name: `${base.name} · max ${(maxH / 100).toFixed(2)} m` };
    const dims = { L: p.L, W: p.W, H: p.maxH - p.deckH };
    const r = optimise(units, dims, p.maxKg);
    pallets = { spec: p, strategy: r.strategy, tried: r.tried,
      spaces: r.spaces.map(s => ({ ...summarise(s, dims, p.tareKg), loadH: +(s.boxes.reduce((m, b) => Math.max(m, b.z + b.h), 0)).toFixed(1) })),
      unpacked: unpackedSummary(r.unpacked) };
    pallets.unpacked.forEach(u => { u.reason = 'Larger than the pallet footprint/height or weight limit'; });
    out.pallets = pallets;
  }

  if (mode === 'container' || mode === 'palletised') {
    const c = CONTAINERS[opts.container] || CONTAINERS['40HC'];
    const dims = { L: c.L, W: c.W, H: c.H };
    const loadUnits = mode === 'container' ? units : expandUnits(pallets.spaces.map((ps, i) => ({
      key: `PAL-${i + 1}`, code: `PAL-${i + 1}`, name: `Pallet ${i + 1}`, ref: '', color: null,
      l: pallets.spec.L, w: pallets.spec.W, h: +(pallets.spec.deckH + ps.loadH).toFixed(1),
      kg: ps.grossKg, cartons: 1, stackable: !!opts.palletStack, canTurn: false, pallet: i,
    })));
    const r = optimise(loadUnits, dims, c.maxKg);
    out.containers = { spec: c, strategy: r.strategy, tried: r.tried,
      spaces: r.spaces.map(s => summarise(s, dims, c.tareKg)), unpacked: unpackedSummary(r.unpacked) };
    out.containers.unpacked.forEach(u => { u.reason = 'Does not fit the container door/inner size or weight limit'; });
  }
  out.ms = Date.now() - t0;
  return out;
}

/** Run container mode across every container type — used for "which container should I book?". */
export function compareContainers(items, opts = {}) {
  return Object.keys(CONTAINERS).map(code => {
    try {
      const r = simulate(items, { ...opts, container: code, mode: opts.mode === 'pallet' ? 'palletised' : (opts.mode || 'container') });
      const sp = r.containers.spaces;
      return { code, name: CONTAINERS[code].name, containers: sp.length,
        unpacked: r.containers.unpacked.reduce((s, u) => s + u.cartons, 0) + (r.pallets?.unpacked || []).reduce((s, u) => s + u.cartons, 0),
        avgFill: sp.length ? +(sp.reduce((s, x) => s + x.fillPct, 0) / sp.length).toFixed(1) : 0,
        lastFill: sp.length ? sp[sp.length - 1].fillPct : 0 };
    } catch (e) { return { code, name: CONTAINERS[code].name, error: e.message }; }
  });
}
