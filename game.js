'use strict';
/* Wood Wide Web — game logic (no DOM). Loaded by index.html. */

// ===== Big numbers stored as log10, so values can grow far past 1e308 =====
class N {
  constructor(l) { this.l = l; } // log10 of the value; -Infinity means 0
  static of(x) {
    if (x instanceof N) return x;
    return new N(typeof x === 'number' && x > 0 ? Math.log10(x) : -Infinity);
  }
  static lg(l) { return new N(l); }
  static load(v) { return typeof v === 'number' && isFinite(v) ? new N(v) : ZERO; }
  get zero() { return this.l === -Infinity; }
  add(b) {
    b = N.of(b);
    if (this.zero) return b;
    if (b.zero) return this;
    const hi = Math.max(this.l, b.l), d = Math.min(this.l, b.l) - hi;
    return new N(d < -17 ? hi : hi + Math.log10(1 + Math.pow(10, d)));
  }
  sub(b) {
    b = N.of(b);
    if (b.l >= this.l) return ZERO;
    const d = b.l - this.l;
    return d < -17 ? this : new N(this.l + Math.log10(1 - Math.pow(10, d)));
  }
  mul(b) { b = N.of(b); return this.zero || b.zero ? ZERO : new N(this.l + b.l); }
  div(b) { b = N.of(b); return this.zero ? ZERO : new N(this.l - b.l); }
  pow(p) { return this.zero ? (p === 0 ? ONE : ZERO) : new N(this.l * p); }
  cmp(b) {
    b = N.of(b);
    const a = this.l, c = b.l;
    if (a === c) return 0;
    if (!isFinite(a) || !isFinite(c)) return a > c ? 1 : -1;
    const eps = 1e-10 * Math.max(1, Math.abs(c));
    return a > c + eps ? 1 : a < c - eps ? -1 : 0;
  }
  gte(b) { return this.cmp(b) >= 0; }
  lt(b) { return this.cmp(b) < 0; }
  max(b) { b = N.of(b); return this.l >= b.l ? this : b; }
  floor() {
    if (this.zero || this.l > 15) return this;
    return N.of(Math.floor(Math.pow(10, this.l) * (1 + 1e-12)));
  }
  num() { return Math.pow(10, this.l); }
  toJSON() { return this.zero ? null : this.l; }
}
const ZERO = new N(-Infinity), ONE = new N(0);

// ===== Formatting =====
function fmt(n, dp = 2) {
  n = N.of(n);
  const l = n.l;
  if (n.zero) return '0';
  if (l < 3) return n.num().toFixed(Math.max(0, dp - Math.max(0, Math.floor(l))));
  if (l < 6) return Math.floor(n.num() + 1e-9).toLocaleString('en-US');
  if (l < 1e6) {
    let e = Math.floor(l), m = Math.pow(10, l - e);
    if (m.toFixed(dp) === (10).toFixed(dp)) { m = 1; e++; }
    return m.toFixed(dp) + 'e' + e.toLocaleString('en-US');
  }
  return 'e' + fmt(N.of(l), dp);
}
function fmtInt(x) { return x < 1e6 ? Math.floor(x).toLocaleString('en-US') : fmt(x); }
function fmtTime(s) {
  if (!isFinite(s)) return '∞';
  if (s < 60) return s.toFixed(1) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.floor(s % 60) + 's';
  if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm';
  return Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h';
}

// ===== Seeded random, so each forest layout is reproducible from its seed =====
function rng(seed) {
  return function () {
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ===== Tile types =====
// cost: log10 of the first feeding price
const TILES = {
  loam:   { name: 'Loam',        cost: 1,   w: 50, info: 'Produces nutrients. Feeding raises its output.' },
  litter: { name: 'Leaf litter', cost: 1.7, w: 17, info: 'Each level adds +10% to all nutrient production.' },
  wood:   { name: 'Deadwood',    cost: 1.7, w: 12, info: 'Once colonized, boosts the loam in the 8 tiles around it. Feeding it raises the boost.' },
  root:   { name: 'Tree root',   cost: 1.5, w: 8,  info: 'A tree trades sugar for your nutrients. Produces sugar.' },
  seep:   { name: 'Water seep',  cost: 2,   w: 6,  info: 'Once colonized, boosts every loam and root in the 8 tiles around it.' },
  stone:  { name: 'Stone',       cost: 0,   w: 7,  info: 'Needs Acidic Hyphae to colonize. Each colonized stone gives ×1.5 nutrients.' },
  truffle:{ name: 'Truffle',     cost: 3,   w: 0,  info: 'Each level adds +5% to spores from Sporulating.' },
};

// ===== State =====
function newGame() {
  const g = {
    nut: ZERO, sugar: ZERO, spores: ZERO, runEarned: ZERO,
    size: 7, seed: 1, grid: [],
    phos: 0, carbon: 0, dense: 0, reach: 0,
    traits: {}, ach: {},
    lineage: 0,
    auto: { feed: true, col: true, trade: true, spor: false },
    stats: { time: 0, runTime: 0, sporulations: 0, migrations: 0, best: ZERO, totalSpores: ZERO },
    last: Date.now(),
  };
  g.seed = (Math.random() * 2 ** 31) | 0;
  g.grid = makeForest(g.seed, g.size, 0);
  return g;
}
let G;
const E = {}; // derived values, refreshed by calc()
const has = id => !!G.traits[id];

function makeForest(seed, size, lineage) {
  const r = rng(seed);
  const pool = Object.entries(TILES).map(([k, v]) => [k, k === 'truffle' ? (lineage >= 3 ? 4 : 0) : v.w]);
  const total = pool.reduce((a, p) => a + p[1], 0);
  const grid = [];
  for (let i = 0; i < size * size; i++) {
    let x = r() * total, t = 'loam';
    for (const [k, w] of pool) { if ((x -= w) < 0) { t = k; break; } }
    grid.push({ t, c: 0, l: 0 });
  }
  const mid = (size >> 1) * size + (size >> 1);
  grid[mid] = { t: 'loam', c: 1, l: 1 };
  // Guarantee a fair start: deadwood beside the start, a root two steps away
  const near = neighbors4(mid, size);
  grid[near[Math.floor(r() * near.length)]].t = 'wood';
  const two = [mid - 2, mid + 2, mid - 2 * size, mid + 2 * size];
  grid[two[Math.floor(r() * 4)]].t = 'root';
  for (const i of near) if (grid[i].t === 'stone') grid[i].t = 'loam';
  return grid;
}
function neighbors4(i, size) {
  const x = i % size, y = Math.floor(i / size), out = [];
  if (x > 0) out.push(i - 1);
  if (x < size - 1) out.push(i + 1);
  if (y > 0) out.push(i - size);
  if (y < size - 1) out.push(i + size);
  return out;
}
function neighbors8(i, size) {
  const x = i % size, y = Math.floor(i / size), out = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue;
    const nx = x + dx, ny = y + dy;
    if (nx >= 0 && ny >= 0 && nx < size && ny < size) out.push(ny * size + nx);
  }
  return out;
}

// ===== Costs =====
function scaled(l, S) { return l < S ? l : l + (l - S) * (l - S) / S; }
const colonized = () => G.grid.reduce((a, t) => a + t.c, 0);
function colRatio() { return 2.4 - (has('rhizo') ? 0.4 : 0) - (G.lineage >= 6 ? 0.2 : 0); }
function colCost(i) { // log10
  const n = colonized();
  return Math.log10(15) + Math.log10(colRatio()) * scaled(n - 1, 40) + (G.grid[i].t === 'stone' ? 2 : 0);
}
function canColonize(i) {
  const t = G.grid[i];
  if (!t || t.c) return false;
  if (t.t === 'stone' && !has('acid')) return false;
  return neighbors4(i, G.size).some(j => G.grid[j].c);
}
function colonize(i) {
  if (!canColonize(i)) return false;
  const c = colCost(i);
  if (G.nut.l < c - 1e-9) return false;
  G.nut = G.nut.sub(N.lg(c));
  G.grid[i].c = 1; G.grid[i].l = G.grid[i].t === 'stone' ? 0 : 1;
  return true;
}
const feedable = t => t.c && t.t !== 'stone';
const feedScaleStart = () => 60 + 25 * G.reach;
function feedCost(t, l = t.l) { // log10 price to go from level l to l+1
  return TILES[t.t].cost + Math.log10(1.5) * scaled(l - 1, feedScaleStart()) - G.carbon * Math.log10(2);
}
function maxLevel(costFn, cur, res) { // highest level count reachable with resource log10 `res`
  res += 1e-9;
  if (!(costFn(cur) <= res)) return cur;
  let lo = cur + 1, hi = cur + 2;
  while (costFn(hi - 1) <= res) { lo = hi; hi = cur + (hi - cur) * 2; if (hi > 1e12) return lo; }
  while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if (costFn(mid - 1) <= res) lo = mid; else hi = mid; }
  return lo;
}
function feed(i, max) {
  const t = G.grid[i];
  if (!t || !feedable(t)) return false;
  const L = max ? maxLevel(l => feedCost(t, l), t.l, G.nut.l) : (feedCost(t) <= G.nut.l + 1e-9 ? t.l + 1 : t.l);
  if (L <= t.l) return false;
  G.nut = G.nut.sub(N.lg(feedCost(t, L - 1)));
  t.l = L;
  return true;
}
// Repeatedly feed whichever tile is cheapest; the even spread this makes is the efficient play
function feedAll(limit = 3000) {
  let n = 0;
  while (n < limit) {
    let best = -1, bc = Infinity;
    for (let i = 0; i < G.grid.length; i++) {
      const t = G.grid[i];
      if (!feedable(t)) continue;
      const c = feedCost(t);
      if (c < bc) { bc = c; best = i; }
    }
    if (best < 0 || bc > G.nut.l + 1e-9) break;
    G.nut = G.nut.sub(N.lg(bc)); G.grid[best].l++; n++;
  }
  return n;
}
function colonizeCheapest() {
  let n = 0;
  for (;;) {
    let best = -1, bc = Infinity;
    for (let i = 0; i < G.grid.length; i++) if (canColonize(i)) {
      const c = colCost(i);
      if (c < bc) { bc = c; best = i; }
    }
    if (best < 0 || !colonize(best)) break;
    n++;
  }
  return n;
}

// ===== Sugar trades =====
const TRADES = {
  phos:   { name: 'Phosphate for sugar', base: 1, ratio: 8,
            desc: () => 'Doubles nutrient production', eff: () => '×' + fmt(N.of(2).pow(G.phos)) },
  carbon: { name: 'Carbon for nitrogen', base: Math.log10(25), ratio: 15,
            desc: () => 'Halves the cost of feeding tiles', eff: () => '÷' + fmt(N.of(2).pow(G.carbon)) },
};
const tradeCost = (id, l = G[id]) => TRADES[id].base + Math.log10(TRADES[id].ratio) * scaled(l, 40);
function buyTrade(id, max) {
  const cur = G[id];
  const L = max ? maxLevel(l => tradeCost(id, l), cur, G.sugar.l) : (tradeCost(id) <= G.sugar.l + 1e-9 ? cur + 1 : cur);
  if (L <= cur) return false;
  G.sugar = G.sugar.sub(N.lg(tradeCost(id, L - 1)));
  G[id] = L;
  return true;
}

// ===== Genome traits (bought with spores) =====
const TRAITS = [
  { id: 'germ',   lin: 0, cost: 1,    name: 'Fast germination', desc: 'Unspent spores boost nutrient production', eff: () => '×' + fmt(E.germ) },
  { id: 'autof',  lin: 0, cost: 5,    name: 'Hungry hyphae',    desc: 'Automatically feed the cheapest tile' },
  { id: 'acid',   lin: 0, cost: 25,   name: 'Acidic hyphae',    desc: 'Lets you colonize stone' },
  { id: 'rhizo',  lin: 0, cost: 100,  name: 'Rhizomorphs',      desc: 'Colonizing gets more expensive more slowly (×2.4 → ×2.0)' },
  { id: 'myco',   lin: 0, cost: 500,  name: 'Mycorrhiza',       desc: 'Tree roots produce 3× sugar' },
  { id: 'autoc',  lin: 0, cost: 2e3,  name: 'Exploration',      desc: 'Automatically colonize the cheapest reachable tile' },
  { id: 'enzyme', lin: 0, cost: 1e4,  name: 'Lignin enzymes',   desc: 'Deadwood boosts are doubled' },
  { id: 'drift',  lin: 1, cost: 1e5,  name: 'Spore drift',      desc: 'Gain 5% of your pending spores every second' },
  { id: 'fusion', lin: 1, cost: 1e6,  name: 'Hyphal fusion',    desc: 'Every colonized tile multiplies nutrients by ×1.04', eff: () => '×' + fmt(E.fusion) },
  { id: 'deep',   lin: 2, cost: 1e8,  name: 'Deep roots',       desc: 'Water seep boosts are tripled' },
  { id: 'glow',   lin: 2, cost: 1e9,  name: 'Bioluminescence',  desc: 'Spores from Sporulating ×3' },
  { id: 'sniff',  lin: 3, cost: 1e11, name: 'Truffle scent',    desc: 'Truffle bonuses are tripled' },
  { id: 'sap',    lin: 3, cost: 1e12, name: 'Sap tap',          desc: 'Sugar you hold boosts nutrient production', eff: () => '×' + fmt(E.sap) },
  { id: 'ring',   lin: 4, cost: 1e14, name: 'Fairy ring',       desc: 'Nutrient production ^1.05' },
  { id: 'autosp', lin: 5, cost: 1e16, name: 'Spore clock',      desc: 'Automatically Sporulate when it would at least double your spores' },
  { id: 'canopy', lin: 6, cost: 1e19, name: 'Canopy drop',      desc: 'Leaf litter bonuses are tripled' },
  { id: 'mat',    lin: 7, cost: 1e22, name: 'Mycelial mat',     desc: 'Nutrient production ^1.05 again' },
  { id: 'elder',  lin: 8, cost: 1e25, name: 'Elder network',    desc: 'Each lineage multiplies nutrients ×100 instead of ×10' },
];
function buyTrait(id) {
  const t = TRAITS.find(x => x.id === id);
  if (!t || G.traits[id] || G.lineage < t.lin || G.spores.lt(t.cost)) return false;
  G.spores = G.spores.sub(t.cost); G.traits[id] = true;
  return true;
}

// Repeatable genome upgrades
const GENES = {
  dense: { name: 'Dense hyphae', base: 2, ratio: 100,
           desc: () => 'Doubles nutrient production', eff: () => '×' + fmt(N.of(2).pow(G.dense)) },
  reach: { name: 'Long reach', base: 4, ratio: 1000,
           desc: () => 'Feeding costs start climbing steeply 25 levels later',
           eff: () => 'from level ' + feedScaleStart() },
};
const geneCost = (id, l = G[id]) => GENES[id].base + Math.log10(GENES[id].ratio) * scaled(l, 30);
function buyGene(id, max) {
  const cur = G[id];
  const L = max ? maxLevel(l => geneCost(id, l), cur, G.spores.l) : (geneCost(id) <= G.spores.l + 1e-9 ? cur + 1 : cur);
  if (L <= cur) return false;
  G.spores = G.spores.sub(N.lg(geneCost(id, L - 1)));
  G[id] = L;
  return true;
}

// Buy every affordable trait (cheapest first), then pour the rest into the repeatable upgrades
function buyAllGenome() {
  let n = 0;
  for (const t of TRAITS.slice().sort((a, b) => a.cost - b.cost)) if (buyTrait(t.id)) n++;
  for (let k = 0; k < 200; k++) {
    const id = geneCost('dense') <= geneCost('reach') ? 'dense' : 'reach';
    if (!buyGene(id, false)) break;
    n++;
  }
  return n;
}
function buyAllTrades() {
  let n = 0;
  for (let k = 0; k < 500; k++) {
    const id = tradeCost('phos') <= tradeCost('carbon') ? 'phos' : 'carbon';
    if (!buyTrade(id, false)) break;
    n++;
  }
  return n;
}

// ===== Lineage (second reset) =====
const MIG = [3, 8, 11.5, 15, 18.5, 22, 24.5, 28.5, 34, 39]; // log10 spores needed to leave each lineage
const migReq = (L = G.lineage) => MIG[Math.min(L, MIG.length - 1)] + Math.max(0, L - MIG.length + 1) * 4;
// The lineage your spores could carry you to right now
function migTarget() { let L = G.lineage; while (G.spores.l >= migReq(L) - 1e-9 && L < G.lineage + 50) L++; return L; }
const LINEAGE = [
  [1, 'Sugar trades are kept when you Sporulate'],
  [2, 'Forests grow to 8 × 8, then one size larger every 2 lineages up to 11 × 11'],
  [3, 'Truffles appear in new forests'],
  [4, 'Sugar ×100. Sugar trades are bought automatically'],
  [6, 'Colonizing gets more expensive more slowly (−0.2)'],
  [7, 'Spores from Sporulating ×3'],
  [8, 'Nutrient production ^1.05'],
  [10, 'The forest is one network. You finished Wood Wide Web; keep growing if you like'],
];
const forestSize = () => 7 + Math.min(4, Math.floor(G.lineage / 2));

// ===== Resets =====
function newForest() {
  G.seed = (G.seed * 1103515245 + 12345) & 0x7fffffff;
  G.size = forestSize();
  G.grid = makeForest(G.seed, G.size, G.lineage);
  G.nut = ZERO; G.runEarned = ZERO; G.stats.runTime = 0;
  if (G.lineage < 1) { G.sugar = ZERO; G.phos = 0; G.carbon = 0; }
}
function sporulate() {
  calc();
  if (E.sporeGain.lt(1)) return false;
  G.spores = G.spores.add(E.sporeGain);
  G.stats.totalSpores = G.stats.totalSpores.add(E.sporeGain);
  G.stats.sporulations++;
  newForest();
  return true;
}
function migrate() {
  const to = migTarget();
  if (to <= G.lineage) return 0;
  const jumped = to - G.lineage;
  G.lineage = to;
  G.stats.migrations++;
  G.spores = ZERO; // your genome (traits and upgrades) is kept
  G.sugar = ZERO; G.phos = 0; G.carbon = 0;
  newForest();
  return jumped;
}

// ===== Achievements =====
const ACHS = [
  { id: 'spread', name: 'First thread', desc: 'Colonize a second tile', ok: () => colonized() >= 2 },
  { id: 'rot', name: 'Rot', desc: 'Colonize deadwood', ok: () => G.grid.some(t => t.c && t.t === 'wood') },
  { id: 'sweet', name: 'Sweet deal', desc: 'Make a sugar trade', ok: () => G.phos + G.carbon > 0 },
  { id: 'k', name: 'Topsoil', desc: 'Hold 1,000 nutrients', ok: () => G.nut.l >= 3 },
  { id: 'm', name: 'Compost heap', desc: 'Hold 1.00e6 nutrients', ok: () => G.nut.l >= 6 },
  { id: 'l25', name: 'Thick mat', desc: 'Feed a tile to level 25', ok: () => G.grid.some(t => t.l >= 25) },
  { id: 'fruit', name: 'Fruiting body', desc: 'Sporulate', ok: () => G.stats.sporulations > 0 },
  { id: 'stone', name: 'Rock eater', desc: 'Colonize stone', ok: () => G.grid.some(t => t.c && t.t === 'stone') },
  { id: 't', name: 'Forest floor', desc: 'Hold 1.00e12 nutrients', ok: () => G.nut.l >= 12 },
  { id: 'full', name: 'Wall to wall', desc: 'Colonize every tile in a forest', ok: () => G.grid.every(t => t.c) },
  { id: 'cloud', name: 'Spore cloud', desc: 'Hold 1.00e6 spores', ok: () => G.spores.l >= 6 },
  { id: 'mig', name: 'On the wind', desc: 'Migrate to a new forest', ok: () => G.lineage >= 1 },
  { id: 'n30', name: 'Bog', desc: 'Hold 1.00e30 nutrients', ok: () => G.nut.l >= 30 },
  { id: 'truf', name: 'Truffle hunter', desc: 'Colonize a truffle', ok: () => G.grid.some(t => t.c && t.t === 'truffle') },
  { id: 'n100', name: 'Old growth', desc: 'Hold 1.00e100 nutrients', ok: () => G.nut.l >= 100 },
  { id: 'l5', name: 'Five generations', desc: 'Reach lineage 5', ok: () => G.lineage >= 5 },
  { id: 'n308', name: 'Deeper than floats', desc: 'Hold 1.80e308 nutrients', ok: () => G.nut.l >= 308.2547 },
  { id: 'www', name: 'Wood Wide Web', desc: 'Reach lineage 10', ok: () => G.lineage >= 10 },
];
function checkAchs() {
  const got = [];
  for (const a of ACHS) if (!G.ach[a.id] && a.ok()) { G.ach[a.id] = true; got.push(a); }
  return got;
}

// ===== Derived values =====
function tileMults(i) {
  // Bonuses from several neighbours add up rather than multiply, so no single lucky tile runs the game
  let wood = 1, seep = 1;
  for (const j of neighbors8(i, G.size)) {
    const n = G.grid[j];
    if (!n.c) continue;
    if (n.t === 'wood') wood += (0.5 + 0.15 * n.l) * (has('enzyme') ? 2 : 1);
    else if (n.t === 'seep') seep += (0.25 + 0.08 * n.l) * (has('deep') ? 3 : 1);
  }
  return { wood, seep };
}
const SPORE_EXP = 0.3, LIN_MULT = 10;
const loamYield = l => N.of(l).mul(N.of(1.15).pow(l - 1));
const rootYield = l => N.of(0.1 * l).mul(N.of(1.15).pow(l - 1));
function calc() {
  const tiles = E.tiles = [];
  let raw = ZERO, sugar = ZERO, litterLv = 0, stones = 0, truffle = 1;
  for (let i = 0; i < G.grid.length; i++) {
    const t = G.grid[i], m = tileMults(i);
    let out = ZERO;
    if (t.c) {
      if (t.t === 'loam') { out = loamYield(t.l).mul(m.wood * m.seep); raw = raw.add(out); }
      else if (t.t === 'root') { out = rootYield(t.l).mul(m.seep); sugar = sugar.add(out); }
      else if (t.t === 'litter') litterLv += t.l;
      else if (t.t === 'stone') stones++;
      else if (t.t === 'truffle') truffle += 0.05 * t.l * (has('sniff') ? 3 : 1);
    }
    tiles.push({ out, wood: m.wood, seep: m.seep });
  }
  const n = colonized();
  E.colonized = n;
  const litter = E.litter = N.of(1 + 0.1 * litterLv * (has('canopy') ? 3 : 1));
  E.stone = N.of(1.5).pow(stones);
  E.phos = N.of(2).pow(G.phos);
  E.germ = has('germ') ? G.spores.add(1).pow(0.15) : ONE;
  E.fusion = has('fusion') ? N.of(1.04).pow(n) : ONE;
  E.ach = N.of(1.05).pow(Object.keys(G.ach).length);
  E.lin = N.of(has('elder') ? 100 : LIN_MULT).pow(G.lineage);
  E.sap = has('sap') ? G.sugar.add(1).pow(0.1) : ONE;
  E.dense = N.of(2).pow(G.dense);
  E.global = E.sap.mul(E.dense).mul(litter).mul(E.stone).mul(E.phos).mul(E.germ).mul(E.fusion).mul(E.ach).mul(E.lin);
  let g = raw.mul(E.global);
  if (has('ring')) g = g.pow(1.05);
  if (has('mat')) g = g.pow(1.05);
  if (G.lineage >= 8) g = g.pow(1.05);
  E.nutGain = g;

  E.sugarGain = sugar.mul((has('myco') ? 3 : 1) * (G.lineage >= 4 ? 100 : 1));
  E.truffle = truffle;
  E.sporeMult = N.of(2 * (has('glow') ? 3 : 1) * (G.lineage >= 1 ? 2 : 1) * truffle).mul(N.of(1.5).pow(G.lineage)).mul(G.lineage >= 7 ? 3 : 1);
  E.sporeGain = G.runEarned.l >= 4 ? G.runEarned.div(1e4).pow(SPORE_EXP).mul(E.sporeMult).floor() : ZERO;
}

// ===== Main tick =====
function tick(dt) {
  calc();
  const made = E.nutGain.mul(dt);
  G.nut = G.nut.add(made);
  G.runEarned = G.runEarned.add(made);
  G.sugar = G.sugar.add(E.sugarGain.mul(dt));
  if (has('drift')) G.spores = G.spores.add(E.sporeGain.mul(0.05 * dt));
  if (G.auto.col && has('autoc')) colonizeCheapest();
  if (G.auto.feed && has('autof')) feedAll(400);
  if (G.auto.trade && G.lineage >= 4) buyAllTrades();
  if (G.auto.spor && has('autosp') && G.stats.runTime > 5) { calc(); if (E.sporeGain.gte(G.spores.max(1))) sporulate(); }
  G.stats.time += dt; G.stats.runTime += dt;
  G.stats.best = G.stats.best.max(G.nut);
  return checkAchs();
}

// ===== Save / load =====
const SAVE_KEY = 'wood-wide-web-save-v1';
function serialize() { G.last = Date.now(); return btoa(unescape(encodeURIComponent(JSON.stringify(G)))); }
function deserialize(str) {
  const d = JSON.parse(decodeURIComponent(escape(atob(str.trim()))));
  if (!Array.isArray(d.grid) || !d.grid.length) throw new Error('No forest in this save');
  const g = newGame();
  for (const k of ['nut', 'sugar', 'spores', 'runEarned']) g[k] = N.load(d[k]);
  for (const k of ['size', 'seed', 'phos', 'carbon', 'dense', 'reach', 'lineage', 'last']) if (typeof d[k] === 'number') g[k] = d[k];
  g.grid = d.grid.map(t => ({ t: TILES[t.t] ? t.t : 'loam', c: t.c ? 1 : 0, l: +t.l || 0 }));
  if (g.grid.length !== g.size * g.size) throw new Error('This save is damaged');
  for (const k of ['traits', 'ach', 'auto']) Object.assign(g[k], d[k] || {});
  Object.assign(g.stats, d.stats || {});
  g.stats.best = N.load(d.stats && d.stats.best);
  g.stats.totalSpores = N.load(d.stats && d.stats.totalSpores);
  return g;
}

G = newGame();
if (typeof module !== 'undefined') {
  module.exports = { N, fmt, newGame, calc, tick, E, get G() { return G; }, set G(v) { G = v; },
    feedAll, colonizeCheapest, buyTrade, buyTrait, buyGene, buyAllGenome, buyAllTrades, migTarget, sporulate, migrate, migReq, TRAITS, colonized };
}
