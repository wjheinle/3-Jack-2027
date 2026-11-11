const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

// Persistent storage: mount a Railway volume at /data (or set DATA_DIR).
let DATA_DIR = process.env.DATA_DIR || '/data';
let usingFallback = false;
let fallbackReason = '';
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const probe = path.join(DATA_DIR, '.write-test');
  fs.writeFileSync(probe, String(Date.now()));
  fs.unlinkSync(probe);
} catch (e) {
  fallbackReason = e.code || e.message;
  console.warn('WARNING: ' + DATA_DIR + ' is not writable (' + fallbackReason + ') uid=' + (process.getuid ? process.getuid() : '?'));
  usingFallback = true;
  DATA_DIR = path.join(__dirname, 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  console.warn('WARNING: could not use persistent dir, falling back to ' + DATA_DIR + ' (data will NOT survive redeploys)');
}
const DATA_FILE = path.join(DATA_DIR, 'scottsdale2027.json');

const id = () => crypto.randomUUID();

function seed() {
  return {
    rev: 1,
    golf: [
      { id: id(), date: '2027-05-30', course: 'WeKoPa Golf Club', layout: 'Cholla', cost: 169, costNote: 'plus tax', teeTime: '', notes: '' },
      { id: id(), date: '2027-05-31', course: 'Grayhawk Golf Club', layout: 'Raptor', cost: 325, costNote: 'plus tax, covers both Raptor and Talon rounds', teeTime: '', notes: '' },
      { id: id(), date: '2027-06-02', course: 'Kierland Golf Club', layout: 'Ironwood / Acacia', cost: 135, costNote: 'plus tax', teeTime: '', notes: '' },
      { id: id(), date: '2027-06-03', course: 'Grayhawk Golf Club', layout: 'Talon', cost: 0, costNote: 'paid ahead with the Raptor round', teeTime: '', notes: '' }
    ],
    flights: [
      { id: id(), dir: 'Arrive', airline: 'JSX', flightNo: 'XE463', date: '2027-05-29', time: '13:10', from: '', to: 'Scottsdale', travelers: 'Bill, Mroz, Andy', confirmation: '', notes: 'Lands 1:10 PM' },
      { id: id(), dir: 'Depart', airline: 'JSX', flightNo: 'XE462', date: '2027-06-04', time: '09:00', from: 'Scottsdale', to: '', travelers: 'Bill, Mroz, Andy', confirmation: '', notes: 'Departs 9:00 AM' },
      { id: id(), dir: 'Arrive', airline: 'Southwest', flightNo: '', date: '', time: '', from: 'Denver', to: 'Phoenix', travelers: 'Meachum', confirmation: '', notes: 'Probably flying Southwest. Details TBD.' },
      { id: id(), dir: 'Arrive', airline: 'United', flightNo: '', date: '', time: '', from: 'Houston', to: 'Phoenix (PHX)', travelers: 'Freddie, Benny', confirmation: '', notes: 'Details TBD.' }
    ],
    expenses: [],
    groceries: [],
    vrbo: {},
    tournament: { notes: '' }
  };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const base = seed();
  for (const k of Object.keys(base)) if (state[k] === undefined) state[k] = base[k];
} catch (e) {
  state = seed();
  save();
}

// One-time rename: Mike -> Mroz (there is also a Mike Meachum)
(function renameMike() {
  const re = /\bMike\b/g;
  let changed = false;
  const fix = v => { const n = v.replace(re, 'Mroz'); if (n !== v) changed = true; return n; };
  state.flights.forEach(f => { if (typeof f.travelers === 'string') f.travelers = fix(f.travelers); });
  state.expenses.forEach(e => {
    if (typeof e.payer === 'string') e.payer = fix(e.payer);
    if (typeof e.to === 'string') e.to = fix(e.to);
    if (Array.isArray(e.split)) e.split = e.split.map(fix);
  });
  state.groceries.forEach(g => { if (typeof g.addedBy === 'string') g.addedBy = fix(g.addedBy); });
  if (changed) save();
})();

function save() {
  state.rev = (state.rev || 0) + 1;
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, DATA_FILE);
}

function clean(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!/^[a-zA-Z]{1,30}$/.test(k) || k === 'id') continue;
    if (typeof v === 'string') out[k] = v.slice(0, 4000);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter(x => typeof x === 'string').slice(0, 30).map(x => x.slice(0, 100));
  }
  return out;
}

const LISTS = ['golf', 'flights', 'expenses', 'groceries'];
const OBJECTS = ['vrbo', 'tournament'];

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => { if (/\.(html|json)$/.test(file)) res.set('Cache-Control', 'no-cache'); }
}));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, dataDir: DATA_DIR, usingFallback, fallbackReason, uid: process.getuid ? process.getuid() : null, rev: state.rev,
    counts: Object.fromEntries(LISTS.map(l => [l, state[l].length])) });
});

app.get('/api/state', (req, res) => {
  res.json({ ...state, usingFallback });
});

app.post('/api/groceries/merge', (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const item = clean(req.body.item);
  if (ids.length < 2 || !item.name) return res.status(400).json({ error: 'bad merge' });
  state.groceries = state.groceries.filter(g => !ids.includes(g.id));
  const merged = { id: id(), createdAt: Date.now(), checked: false, ...item };
  state.groceries.push(merged);
  save();
  res.json(merged);
});

app.post('/api/:coll', (req, res) => {
  const c = req.params.coll;
  if (!LISTS.includes(c)) return res.status(404).json({ error: 'unknown' });
  const item = { id: id(), createdAt: Date.now(), ...clean(req.body) };
  state[c].push(item);
  save();
  res.json(item);
});

app.patch('/api/:coll/:id', (req, res) => {
  const c = req.params.coll;
  if (!LISTS.includes(c)) return res.status(404).json({ error: 'unknown' });
  const it = state[c].find(x => x.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  Object.assign(it, clean(req.body));
  save();
  res.json(it);
});

app.delete('/api/:coll/:id', (req, res) => {
  const c = req.params.coll;
  if (!LISTS.includes(c)) return res.status(404).json({ error: 'unknown' });
  const before = state[c].length;
  state[c] = state[c].filter(x => x.id !== req.params.id);
  if (state[c].length !== before) save();
  res.json({ ok: true });
});

app.put('/api/:obj', (req, res) => {
  const o = req.params.obj;
  if (!OBJECTS.includes(o)) return res.status(404).json({ error: 'unknown' });
  state[o] = clean(req.body);
  save();
  res.json(state[o]);
});

app.listen(PORT, () => console.log('Scottsdale 2027 on :' + PORT + ' data: ' + DATA_FILE));
