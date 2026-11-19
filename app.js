// HYROX booker — the phone app.
//
// A static page with no server of its own:
//   - the classes come straight from the club's calendar page, which allows
//     cross-site reads (it echoes the Origin back in Access-Control-Allow-Origin);
//   - the choices live in config.json of the private booker repo, read and written
//     through the GitHub API with a token kept only in this app's storage;
//   - results come from status.json, which the booker commits after each run;
//   - "Book now" starts the booker's workflow for one date.
//
// config.json, shared with book.mjs:
//   targets  weekly rules        { weekday: "sun", time: "08:30", name: "HYROX" }
//   skip     one date off a rule { date: "2026-11-29", time, name }
//   add      one extra class     { date, time, name }

const GYM = 'https://spilka.formfactory.sk';
const TZ = 'Europe/Bratislava'; // the club's clock, whatever the phone's zone is
const DAYS = 14;
const SHOW = /hyrox/i;
const BRANCH = 'main';
const WORKFLOW = 'book.yml';
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WD_JS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WD_SHORT = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const WD_LONG = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// The nightly run starts at 23:15 and reads config.json then: later changes for
// that night's opening miss it.
const RUN_LEAD_MS = 45 * 60_000;

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const same = (a, b) => a.time === b.time && a.name.toUpperCase() === b.name.toUpperCase();
const keyOf = (date, c) => `${date} ${c.time} ${c.name.toUpperCase()}`; // = book.mjs statusKey

// ---------- time, always in the club's zone ----------

function localParts(date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute };
}
const isoOf = ({ y, m, d }) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const ymd = (s) => s.split('-').map(Number);
const addDays = (s, n) => { const [y, m, d] = ymd(s); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const weekdayOf = (s) => { const [y, m, d] = ymd(s); return WD_JS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]; };
const todayIso = () => isoOf(localParts(new Date()));
// UTC instant of a club-local date and time.
function localTime(s, hhmm = '00:00') {
  const [y, m, d] = ymd(s);
  const [h, mi] = hhmm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const p = localParts(new Date(guess));
  return new Date(guess - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess));
}
// Registration opens at 00:00, three days before the class.
const opensAt = (date) => localTime(addDays(date, -3));
const shortDate = (s) => { const [, m, d] = ymd(s); return `${d} ${MONTHS[m - 1]}`; };

// ---------- settings (this phone only) ----------

const SETTINGS_KEY = 'hyrox.settings';
let settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null') || { repo: '', token: '' };
const configured = () => !!(settings.repo && settings.token);

// ---------- GitHub ----------

async function gh(path, { method = 'GET', body } = {}) {
  const r = await fetch(`https://api.github.com/repos/${settings.repo}/${path}`, {
    method,
    cache: 'no-store',
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(
      r.status === 401 ? 'GitHub rejected the token (401). Check it in Settings.'
      : r.status === 403 ? `No permission (403). The token needs Contents and Actions, read and write, on ${settings.repo}.`
      : r.status === 404 ? `Not found (404). Check the repository name, and that the token includes ${settings.repo}.`
      : `GitHub ${r.status}: ${data.message || r.statusText}`,
    );
    e.status = r.status;
    throw e;
  }
  return data;
}

const b64encode = (s) => { let bin = ''; for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b); return btoa(bin); };
const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

async function readJson(file) {
  try {
    const d = await gh(`contents/${file}?ref=${BRANCH}`);
    return { json: JSON.parse(b64decode(d.content)), sha: d.sha };
  } catch (e) {
    if (e.status === 404 && file !== 'config.json') return { json: null, sha: null };
    throw e;
  }
}

async function writeJson(file, json, sha, message) {
  const d = await gh(`contents/${file}`, {
    method: 'PUT',
    body: { message, content: b64encode(`${JSON.stringify(json, null, 2)}\n`), sha, branch: BRANCH },
  });
  return d.content.sha;
}

// ---------- the club calendar ----------

// The week view is one table: thead has a `meta:date="24. 11. 2026"` link per day,
// the single body row one <td> per day in the same order (as in book.mjs).
async function fetchWeek(date) {
  const [y, m, d] = ymd(date);
  const r = await fetch(`${GYM}/calendar?day=${d}.+${m}.+${y}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`club calendar answered ${r.status}`);
  const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
  const table = doc.querySelector('table.calendar_table');
  if (!table) throw new Error('club calendar page has changed (no calendar table)');
  const dates = [...table.querySelectorAll('thead .scheduler-go-to-day')].map((a) => {
    const [dd, mm, yy] = (a.getAttribute('meta:date') || '').match(/\d+/g) || [];
    return yy ? isoOf({ y: +yy, m: +mm, d: +dd }) : null;
  });
  const row = [...table.querySelectorAll('tr')].find((tr) => !tr.closest('thead'));
  const out = [];
  [...(row?.children ?? [])].forEach((td, i) => {
    if (!dates[i]) return;
    for (const e of td.querySelectorAll('.event')) {
      const [start, end] = (e.querySelector('.eventlength')?.textContent || '').trim().split('-').map((x) => x.trim());
      const name = e.querySelector('.event_name')?.textContent.trim() || '';
      if (start) out.push({ date: dates[i], time: start, end: end || '', name, id: e.getAttribute('meta:id') });
    }
  });
  return out;
}

async function loadClasses() {
  const from = todayIso();
  const to = addDays(from, DAYS - 1);
  const weeks = await Promise.all([from, addDays(from, 7), to].map(fetchWeek));
  const seen = new Set();
  return weeks.flat()
    .filter((c) => c.date >= from && c.date <= to && SHOW.test(c.name))
    .filter((c) => !seen.has(c.id) && seen.add(c.id))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// ---------- choices ----------

function ruleFor(cfg, date, c) {
  const wd = weekdayOf(date);
  return (cfg.targets ?? []).some((t) => t.weekday.toLowerCase().startsWith(wd) && same(t, c));
}

function wanted(cfg, date, c) {
  if ((cfg.add ?? []).some((a) => a.date === date && same(a, c))) return true;
  return ruleFor(cfg, date, c) && !(cfg.skip ?? []).some((s) => s.date === date && same(s, c));
}

// Ops are replayed onto the newest config.json before each save, so a save never
// overwrites what another device (or a hand edit) changed meanwhile.
function applyOp(cfg, op) {
  cfg.targets ??= [];
  cfg.skip ??= [];
  cfg.add ??= [];
  const c = { time: op.time, name: op.name };
  if (op.kind === 'weekly') {
    cfg.targets = cfg.targets.filter((t) => !(t.weekday.toLowerCase().startsWith(op.weekday) && same(t, c)));
    if (op.on) cfg.targets.push({ weekday: op.weekday, ...c });
    // A weekly switch means "every week": one-off changes to that slot go with it.
    const slot = (x) => weekdayOf(x.date) === op.weekday && same(x, c);
    cfg.skip = cfg.skip.filter((x) => !slot(x));
    cfg.add = cfg.add.filter((x) => !slot(x));
  } else {
    const rule = ruleFor(cfg, op.date, c);
    cfg.skip = cfg.skip.filter((x) => !(x.date === op.date && same(x, c)));
    cfg.add = cfg.add.filter((x) => !(x.date === op.date && same(x, c)));
    if (op.on && !rule) cfg.add.push({ date: op.date, ...c });
    if (!op.on && rule) cfg.skip.push({ date: op.date, ...c });
  }
  const today = todayIso();
  const byDate = (a, b) => (a.date + a.time).localeCompare(b.date + b.time);
  cfg.skip = cfg.skip.filter((x) => x.date >= today).sort(byDate);
  cfg.add = cfg.add.filter((x) => x.date >= today).sort(byDate);
  cfg.targets.sort((a, b) => WEEK.indexOf(a.weekday.slice(0, 3).toLowerCase()) - WEEK.indexOf(b.weekday.slice(0, 3).toLowerCase()) || a.time.localeCompare(b.time));
  return cfg;
}

const opText = (op) => op.kind === 'weekly'
  ? `${op.on ? '+' : '-'} every ${WD_SHORT[op.weekday]} ${op.time} ${op.name}`
  : `${op.on ? '+' : '-'} ${op.date} ${op.time} ${op.name}`;

// ---------- state ----------

const state = {
  tab: 'days',
  classes: [],
  server: null, // config.json as last read or written
  sha: null,
  status: {},
  pending: [],  // ops not saved yet
  saving: false,
  booking: {},  // key -> ms when "Book now" started it
  loading: false,
  loadedAt: 0,
  calError: '',
  ghError: '',
};

const view = () => state.pending.reduce((cfg, op) => applyOp(cfg, op), structuredClone(state.server ?? { targets: [] }));

// ---------- saving ----------

let flushTimer = 0;
const idleWaiters = [];

function queue(op) {
  state.pending.push(op);
  render();
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 800); // a few quick taps make one commit
}

async function flush() {
  clearTimeout(flushTimer);
  if (state.saving || !state.pending.length) return settle();
  state.saving = true;
  toast('Saving…');
  const ops = state.pending.slice();
  try {
    for (let attempt = 0; ; attempt++) {
      let base = state.server;
      let sha = state.sha;
      if (attempt > 0 || !base) ({ json: base, sha } = await readJson('config.json'));
      const next = ops.reduce((cfg, op) => applyOp(cfg, op), structuredClone(base));
      try {
        state.sha = await writeJson('config.json', next, sha, `app: ${ops.map(opText).join(', ')}`);
        state.server = next;
        break;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 3) continue; // someone else saved first
        throw e;
      }
    }
    state.pending.splice(0, ops.length);
    toast('Saved');
  } catch (e) {
    state.pending = [];
    toast(`Not saved: ${e.message}`, true);
    await readJson('config.json').then((f) => { state.server = f.json; state.sha = f.sha; }).catch(() => {});
  } finally {
    state.saving = false;
    render();
    if (state.pending.length) flush(); else settle();
  }
}

function settle() {
  if (state.saving || state.pending.length) return;
  idleWaiters.splice(0).forEach((r) => r());
}
const saved = () => new Promise((r) => { idleWaiters.push(r); flush(); });

// ---------- book now ----------

let pollTimer = 0;

async function bookNow(c) {
  const key = keyOf(c.date, c);
  state.booking[key] = Date.now();
  render();
  try {
    await saved();
    if (!wanted(view(), c.date, c)) throw new Error('the class is not ticked');
    await gh(`actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      body: { ref: BRANCH, inputs: { book_date: c.date, dry_run: 'false' } },
    });
    toast('Booking started. The result shows here in a minute or two.');
    pollStatus();
  } catch (e) {
    delete state.booking[key];
    toast(`Could not start booking: ${e.message}`, true);
    render();
  }
}

// After "Book now": re-read status.json every 20 s for up to 6 minutes.
function pollStatus(round = 0) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try { state.status = (await readJson('status.json')).json ?? {}; } catch { /* next round */ }
    const now = Date.now();
    for (const [k, t] of Object.entries(state.booking)) {
      const st = state.status[k];
      if ((st && Date.parse(st.at) >= t) || now - t > 6 * 60_000) delete state.booking[k];
    }
    render();
    if (Object.keys(state.booking).length && round < 18) pollStatus(round + 1);
  }, 20_000);
}

// ---------- loading ----------

let reloadAfter = false;
async function load() {
  // A load asked for during another (e.g. right after Settings → Save) must still
  // happen: the running one may have started without a token.
  if (state.loading) { reloadAfter = true; return; }
  state.loading = true;
  render();
  const [cal, cfg, st] = await Promise.allSettled([
    loadClasses(),
    configured() ? readJson('config.json') : Promise.reject(new Error('not set up')),
    configured() ? readJson('status.json') : Promise.resolve({ json: {} }),
  ]);
  if (cal.status === 'fulfilled') { state.classes = cal.value; state.calError = ''; } else state.calError = cal.reason.message;
  if (cfg.status === 'fulfilled') {
    if (!state.saving) { state.server = cfg.value.json; state.sha = cfg.value.sha; }
    state.ghError = '';
  } else state.ghError = configured() ? cfg.reason.message : '';
  if (st.status === 'fulfilled') state.status = st.value.json ?? {};
  state.loading = false;
  state.loadedAt = Date.now();
  render();
  if (reloadAfter) { reloadAfter = false; load(); }
}

// ---------- rendering ----------

function statusLine(c, want, now) {
  const key = keyOf(c.date, c);
  const st = state.status[key];
  const open = opensAt(c.date);
  const openText = `${WD_SHORT[weekdayOf(addDays(c.date, -3))]} ${shortDate(addDays(c.date, -3))}, 00:00`;
  if (state.booking[key]) return { tone: 'busy', text: 'Booking…' };
  if (st?.state === 'booked') return { tone: 'ok', text: want ? 'Booked' : 'Booked. Unticking does not cancel it: cancel on the club site.' };
  if (now < open) {
    if (!want) return { tone: 'muted', text: `Registration opens ${openText}` };
    return { tone: 'plan', text: open - now <= RUN_LEAD_MS ? 'Auto-books tonight at 00:00' : `Auto-books ${openText}` };
  }
  if (st?.state === 'failed') return { tone: 'bad', text: `Not booked: ${st.note || 'see the mail'}`, book: want };
  if (st?.state === 'missing') return { tone: 'bad', text: 'The booker did not find this class', book: want };
  if (want) return { tone: 'warn', text: 'Registration open, not booked yet', book: true };
  return { tone: 'muted', text: 'Registration open' };
}

function renderDays(cfg) {
  const now = Date.now();
  const today = todayIso();
  const list = state.classes.filter((c) => localTime(c.date, c.time) > now);
  if (!list.length) return `<p class="empty">${state.loading ? 'Loading classes…' : 'No HYROX classes in the next 14 days.'}</p>`;
  let html = '';
  let last = '';
  list.forEach((c) => {
    if (c.date !== last) {
      if (last) html += '</ul>';
      const rel = c.date === today ? 'Today' : c.date === addDays(today, 1) ? 'Tomorrow' : '';
      html += `<h3 class="day">${WD_LONG[weekdayOf(c.date)]} ${shortDate(c.date)}${rel ? `<span>${rel}</span>` : ''}</h3><ul class="list">`;
      last = c.date;
    }
    const want = wanted(cfg, c.date, c);
    const line = statusLine(c, want, now);
    const i = state.classes.indexOf(c);
    const rule = ruleFor(cfg, c.date, c);
    html += `
      <li class="item ${want ? 'on' : ''}">
        <div class="time"><b>${esc(c.time)}</b><small>${esc(c.end)}</small></div>
        <div class="what">
          <div class="name">${esc(c.name)}${rule ? '<span class="tag">weekly</span>' : ''}</div>
          <div class="state ${line.tone}">${esc(line.text)}</div>
          ${line.book && !state.booking[keyOf(c.date, c)] ? `<button class="book" data-book="${i}">Book now</button>` : ''}
        </div>
        <label class="switch"><input type="checkbox" data-date="${i}" ${want ? 'checked' : ''} ${configured() ? '' : 'disabled'}><span></span></label>
      </li>`;
  });
  return `${html}</ul>`;
}

function renderWeekly(cfg) {
  const slots = new Map();
  for (const c of state.classes) {
    const wd = weekdayOf(c.date);
    const k = `${wd} ${c.time} ${c.name.toUpperCase()}`;
    if (!slots.has(k)) slots.set(k, { weekday: wd, time: c.time, end: c.end, name: c.name, seen: true });
  }
  for (const t of cfg.targets ?? []) {
    const wd = t.weekday.slice(0, 3).toLowerCase();
    const k = `${wd} ${t.time} ${t.name.toUpperCase()}`;
    if (!slots.has(k)) slots.set(k, { weekday: wd, time: t.time, end: '', name: t.name, seen: false });
  }
  const all = [...slots.values()].sort((a, b) => WEEK.indexOf(a.weekday) - WEEK.indexOf(b.weekday) || a.time.localeCompare(b.time));
  if (!all.length) return `<p class="empty">${state.loading ? 'Loading classes…' : 'No HYROX classes found.'}</p>`;
  let html = '<p class="note">Classes ticked here are booked every week. Switching one resets the one-off changes for it in the 14-day list.</p>';
  for (const wd of WEEK) {
    const day = all.filter((s) => s.weekday === wd);
    if (!day.length) continue;
    html += `<h3 class="day">${WD_LONG[wd]}</h3><ul class="list">`;
    for (const s of day) {
      const on = (cfg.targets ?? []).some((t) => t.weekday.toLowerCase().startsWith(wd) && same(t, s));
      html += `
        <li class="item ${on ? 'on' : ''}">
          <div class="time"><b>${esc(s.time)}</b><small>${esc(s.end)}</small></div>
          <div class="what">
            <div class="name">${esc(s.name)}</div>
            ${s.seen ? '' : '<div class="state bad">Not in the calendar for the next 2 weeks</div>'}
          </div>
          <label class="switch"><input type="checkbox" data-weekly="${esc(JSON.stringify({ weekday: wd, time: s.time, name: s.name }))}" ${on ? 'checked' : ''} ${configured() ? '' : 'disabled'}><span></span></label>
        </li>`;
    }
    html += '</ul>';
  }
  return html;
}

function render() {
  const cfg = view();
  document.querySelectorAll('.seg button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === state.tab)));
  $('#refresh').classList.toggle('spin', state.loading);
  const msgs = [];
  if (!configured()) msgs.push('Not set up yet: open <b>Settings</b> and enter the repository and token. Until then you can only look.');
  if (state.ghError) msgs.push(`GitHub: ${esc(state.ghError)}`);
  if (state.calError) msgs.push(`Club calendar: ${esc(state.calError)}`);
  $('#banner').hidden = !msgs.length;
  $('#banner').innerHTML = msgs.join('<br>');
  $('#sub').textContent = state.pending.length || state.saving ? 'saving…' : 'auto-booking';
  $('#main').innerHTML = state.tab === 'days' ? renderDays(cfg) : renderWeekly(cfg);
}

let toastTimer = 0;
let warnUntil = 0;
function toast(text, bad = false) {
  if (!bad && Date.now() < warnUntil) return; // "Saving…" must not hide a warning
  if (bad) warnUntil = Date.now() + 6000;
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2500);
}

// ---------- events ----------

$('#main').addEventListener('change', (e) => {
  const el = e.target;
  if (el.dataset.date !== undefined) {
    const c = state.classes[+el.dataset.date];
    queue({ kind: 'date', date: c.date, time: c.time, name: c.name, on: el.checked });
    const left = opensAt(c.date) - Date.now();
    if (left > 0 && left <= RUN_LEAD_MS) toast('Tonight\'s run started at 23:15 with the old list. After 00:00, use Book now.', true);
  } else if (el.dataset.weekly) {
    queue({ kind: 'weekly', ...JSON.parse(el.dataset.weekly), on: el.checked });
  }
});

$('#main').addEventListener('click', (e) => {
  const b = e.target.closest('[data-book]');
  if (b) bookNow(state.classes[+b.dataset.book]);
});

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => { state.tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));
$('#refresh').addEventListener('click', load);

// Coming back to the app after a while: show fresh data.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > 60_000) load();
});

// ---------- settings ----------

const dlg = $('#settings');

function openSettings() {
  $('#set-repo').value = settings.repo;
  $('#set-token').value = settings.token;
  $('#set-error').hidden = true;
  dlg.showModal();
}

$('#open-settings').addEventListener('click', openSettings);
$('#set-cancel').addEventListener('click', () => dlg.close());
$('#set-forget').addEventListener('click', () => {
  settings = { repo: settings.repo, token: '' };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  $('#set-token').value = '';
  state.server = null;
  render();
});

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const prev = settings;
  settings = {
    repo: $('#set-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, ''),
    token: $('#set-token').value.trim(),
  };
  const err = $('#set-error');
  err.hidden = true;
  $('#set-save').disabled = true;
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(settings.repo)) throw new Error('Repository must look like owner/repo.');
    if (!settings.token) throw new Error('Enter the token.');
    await readJson('config.json');
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    dlg.close();
    toast('Connected');
    load();
  } catch (x) {
    settings = prev;
    err.textContent = x.message;
    err.hidden = false;
  } finally {
    $('#set-save').disabled = false;
  }
});

// ---------- start ----------

render();
load();
if (!configured()) openSettings();
