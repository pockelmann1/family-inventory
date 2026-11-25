// Fonts are served with the site (no Google Fonts request before the page shows).
import '@fontsource/cormorant-garamond/latin-400.css';
import '@fontsource/cormorant-garamond/latin-400-italic.css';
import '@fontsource/cormorant-garamond/latin-500.css';
import '@fontsource/jost/latin-300.css';
import '@fontsource/jost/latin-400.css';
import '@fontsource/jost/latin-500.css';
import './style.css';
import { makeApi } from './api.js';
import { makeZip } from './zip.js';

const app = document.getElementById('app');
const BASE = import.meta.env.BASE_URL;
const KEY_STORE = 'fi_key';

// ------------------------------------------------------------------ helpers

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function store(kind) {
  try { return window[kind]; } catch { return null; }
}
const getStored = (k, kind = 'localStorage') => { try { return store(kind)?.getItem(k) ?? null; } catch { return null; } };
const setStored = (k, v, kind = 'localStorage') => { try { v == null ? store(kind)?.removeItem(k) : store(kind)?.setItem(k, v); } catch { /* private mode */ } };

let toastTimer;
function toast(msg, isError = false) {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = `toast${isError ? ' error' : ''}`;
  el.setAttribute('role', 'status');
  el.textContent = msg;
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), isError ? 5000 : 2200);
}

const fmtDate = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

// Links sent to people use ?k=, which survives email security wrappers that
// drop or rewrite the # part of a link.
function personalLink(key) {
  return `${location.origin}${BASE}?k=${key}`;
}

// ------------------------------------------------------------------ sign-in
//
// A personal link looks like .../family-inventory/?k=KEY (older links use
// #k=KEY). Once the server accepts the key it stays in the address as ?k=, so
// the site keeps working from a bookmark, a Home Screen icon, "Open in
// Safari" from inside Gmail or Facebook, or after Safari clears its storage.
// It is also kept in this browser's storage as a backup.

const KEY_RE = /[#?&/]k=([A-Za-z0-9_-]{20,})/;
const NAME_STORE = 'fi_name';
const VIEW_STORES = ['fi_browse', 'fi_results', 'fi_family', 'fi_fill', 'fi_from',
  'fi_scroll_browse', 'fi_scroll_family', 'fi_scroll_results', 'fi_scroll_fill'];

// The key in the address, if any. Tolerates links that arrive with # or =
// written as %23 or %3D, and trailing punctuation from the message.
function keyFromUrl() {
  for (const part of [location.hash, location.search, location.pathname]) {
    let s = part;
    for (let i = 0; i < 2; i++) { try { s = decodeURIComponent(s); } catch { break; } }
    const m = s.match(KEY_RE);
    if (m) return m[1];
  }
  return null;
}

// True when the address carries a k= that isn't a usable key (cut off, or
// with text typed onto the end), so we can say so instead of showing Welcome.
const brokenKeyInUrl = () => !keyFromUrl() && /[#?&]k(=|%3D)/i.test(`${location.hash}${location.search}`);

let memoryKey = null;
const savedKey = () => getStored(KEY_STORE) || getStored(KEY_STORE, 'sessionStorage');

function rememberKey(key, name) {
  memoryKey = key;
  setStored(KEY_STORE, key);
  setStored(KEY_STORE, key, 'sessionStorage');
  setStored(NAME_STORE, name);
  const route = location.hash.startsWith('#/') ? location.hash : '#/';
  history.replaceState(null, '', `${BASE}?k=${key}${route}`);
}

function forgetKey() {
  memoryKey = null;
  setStored(KEY_STORE, null);
  setStored(KEY_STORE, null, 'sessionStorage');
  setStored(NAME_STORE, null);
  VIEW_STORES.forEach((k) => setStored(k, null, 'sessionStorage'));
  history.replaceState(null, '', BASE);
}

function showSignedOut(message) {
  app.innerHTML = `
    <div class="center-box">
      <p class="eyebrow">Family Inventory</p>
      <h1>Welcome</h1>
      <p>${esc(message || 'Please tap the personal link Paul sent you by text or email. It signs you in on this device.')}</p>
    </div>`;
}

// Called by the API whenever the server turns a key down mid-visit.
function onInvalidLink(key) {
  if (key !== memoryKey) return;
  forgetKey();
  state.me = null;
  state.api = null;
  showSignedOut('This link has been turned off or replaced. Please tap the newest link Paul sent you, or ask him for a new one.');
}

function signOutHere() {
  forgetKey();
  state.me = null;
  state.api = null;
  showSignedOut('You are signed out on this device. Tap your personal link to sign in again.');
}

// ------------------------------------------------------------------ state

const state = {
  api: null,
  me: null,
  families: [],
  items: [],
  byId: new Map(),
  people: new Map(), // id -> { name, role, family_id }
  top10: {}, // personId -> [itemId, ...] for the lists this person may see
  loadedAt: 0,
};

function ingest(data) {
  state.me = data.me;
  state.families = data.families;
  state.items = data.items;
  state.byId = new Map(data.items.map((i) => [i.id, i]));
  state.top10 = data.top10 || {};
  state.stage = data.stage || null;
  state.people = new Map();
  for (const f of data.families) for (const m of f.members) state.people.set(String(m.id), { ...m, family_id: f.id });
  state.loadedAt = Date.now();
}

const familyName = (id) => state.families.find((f) => f.id === Number(id))?.name ?? '';
const myRank = (item) => item.ranks[String(state.me.id)] ?? null;
const canRank = () => state.me.family_id != null;
// The admin and the four siblings can change item details; children cannot.
const canEdit = () => !!state.me.is_editor;
// Siblings can adjust their own family's rank for an item while ranking is open.
const canSetFamilyRank = () => state.me.role === 'sibling' && canRank() && rankingOpen();
const famSet = (item, famId) => (item.family_set || {})[String(famId)] || null;
const photoOf = (item) => item.photos[0] || null;
const rooms = () => [...new Set(state.items.map((i) => i.room).filter(Boolean))].sort();
const types = () => [...new Set(state.items.map((i) => i.type).filter(Boolean))].sort();

// Pick list for an item's type. Anyone can add a new type; once saved on an
// item it shows up in the list for everyone.
const BASE_TYPES = ['Art', 'Books', 'Ceramics', 'Decor', 'Furniture', 'Glass', 'Kitchen', 'Lighting',
  'Object', 'Silver and metal', 'Textiles and rugs', 'Other'];
const typeChoices = () => [...new Set([...BASE_TYPES, ...types()])].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
// Subtypes already used under a type (all used subtypes when no type is chosen yet).
const subtypeChoices = (type) => [...new Set(state.items
  .filter((i) => i.subtype && (!type || i.type === type)).map((i) => i.subtype))]
  .sort((a, b) => a.localeCompare(b));
const PICKS = {
  type: { choose: 'Choose a type…', add: 'Add a new type…', example: 'New type, for example Clocks' },
  subtype: { choose: 'No subtype', add: 'Add a new subtype…', example: 'New subtype, for example Mantel clock' },
};
function pickOptions(kind, list, current) {
  const cur = current || '';
  const t = PICKS[kind];
  return `<option value="" ${cur ? '' : 'selected'}>${t.choose}</option>
    ${list.map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('')}
    ${cur && !list.includes(cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : ''}
    <option value="__new">${t.add}</option>`;
}
function pickHtml(kind, list, current, attrs = '') {
  return `
    <span class="type-pick" data-kind="${kind}">
      <select class="select edit-val" ${attrs}>${pickOptions(kind, list, current)}</select>
      <input class="input new-type" placeholder="${PICKS[kind].example}" hidden aria-label="${PICKS[kind].add.replace('…', '')}" />
    </span>`;
}
const typeSelectHtml = (current, attrs = '') => pickHtml('type', typeChoices(), current, attrs);
const subtypeSelectHtml = (current, type, attrs = '') => pickHtml('subtype', subtypeChoices(type), current, attrs);
// The value of a picker: the chosen value, or the new one typed in.
function pickValue(box, kind) {
  const pick = box.querySelector(`.type-pick[data-kind="${kind}"]`);
  const sel = pick.querySelector('select');
  return sel.value === '__new' ? pick.querySelector('.new-type').value.trim() : sel.value;
}
const typeValue = (box) => pickValue(box, 'type');
document.addEventListener('change', (e) => {
  const sel = e.target.closest('.type-pick select');
  if (!sel) return;
  const input = sel.parentElement.querySelector('.new-type');
  input.hidden = sel.value !== '__new';
  if (!input.hidden) input.focus();
  // A new type changes which subtypes are offered next to it (Edit info form).
  const form = sel.closest('form');
  const subSel = form?.querySelector('.type-pick[data-kind="subtype"] select');
  if (sel.parentElement.dataset.kind === 'type' && subSel && subSel.value !== '__new') {
    const type = sel.value === '__new' ? '' : sel.value;
    const keep = subSel.value;
    subSel.innerHTML = pickOptions('subtype', subtypeChoices(type), keep);
  }
});


// Other families' ranks stay out of Browse and the item page for people who are ranking,
// so nobody ranks against what they see (their own family is on My family; Results is admin only).
const seesOthers = () => !canRank();

// "Most wanted by Susan's family (best rank 2)", or several families when tied.
function bestLine(item) {
  if (!seesOthers() || item.overall_best == null) return '';
  const names = item.top_families.map((id) => `${familyName(id)}'s`);
  const who = names.length === 1 ? `${names[0]} family`
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} families (tied)`;
  return `Most wanted by ${esc(who)}, best rank ${item.overall_best}`;
}

// ------------------------------------------------------------------ layout

function shell(active, content) {
  const tabs = [
    ['browse', '#/', 'Browse'],
    ...(canRank() ? [['family', '#/family', 'My family']] : []),
    ...(state.me.is_admin ? [['results', '#/results', 'Results'], ['assign', '#/assign', 'Assign']] : []),
  ];
  if (state.me.is_admin) tabs.push(['admin', '#/admin', 'Admin']);
  app.innerHTML = `
    <header class="site-header">
      <div class="inner">
        <a class="wordmark" href="#/">Family Inventory</a>
        <span class="whoami">${canRank() ? 'Ranking as' : 'Signed in as'} <b>${esc(state.me.name)}</b></span>
        <nav class="nav" aria-label="Main">
          ${tabs.map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('')}
        </nav>
      </div>
    </header>
    <main id="main">${content}</main>
    <footer class="site-footer">Signed in as ${esc(state.me.name)}. Ranks: 1 means most wanted.
      <button type="button" class="link-btn" id="sign-out">Not ${esc(state.me.name)}? Sign out of this device</button></footer>`;
  document.getElementById('sign-out').addEventListener('click', (e) => {
    if (!confirmInline(e.target, 'Tap again to sign out. You will need your personal link to sign back in.')) return;
    signOutHere();
  });
}

function rankerHtml(item, large = false) {
  if (!canRank()) return '';
  const mine = myRank(item);
  if (!rankingOpen()) { // ranking is closed: show the rank, but it can't change
    return `
    <div class="ranker locked${large ? ' large' : ''}" data-item="${esc(item.id)}" role="group" aria-label="Your rank for ${esc(item.name)} (ranking is closed)">
      ${large ? '<span class="label">My rank <span class="hint">ranking is closed</span></span>' : ''}
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-rank="${n}" aria-pressed="${mine === n}" aria-label="Rank ${n}" disabled>${n}</button>`).join('')}
      <span class="lockline">${mine != null ? `Your rank: ${mine}` : 'Not ranked'}</span>
    </div>`;
  }
  return `
    <div class="ranker${large ? ' large' : ''}" data-item="${esc(item.id)}" role="group" aria-label="My rank for ${esc(item.name)}">
      ${large ? '<span class="label">My rank <span class="hint">1 = want most</span></span>' : ''}
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-rank="${n}" aria-pressed="${mine === n}" aria-label="Rank ${n}">${n}</button>`).join('')}
      ${large
        ? (mine != null ? '<button type="button" class="clear" data-rank="">Clear my rank</button>' : '')
        : `<button type="button" class="clear${mine == null ? ' off' : ''}" data-rank="" ${mine == null ? 'tabindex="-1" aria-hidden="true"' : ''}>Clear my rank</button>`}
    </div>`;
}

function thumbImg(item, cls = '') {
  const p = photoOf(item);
  if (!p?.thumb) return `<div class="placeholder ${cls}">Photo coming</div>`;
  // Sharp screens get the larger photo; others keep the small, fast one.
  const srcset = p.full ? ` srcset="${esc(p.thumb)} 360w, ${esc(p.full)} 768w" sizes="(max-width: 700px) 50vw, 340px"` : '';
  return `<img class="${cls}" src="${esc(p.thumb)}"${srcset} alt="${esc(item.name)}" loading="lazy" decoding="async" />`;
}

// Rank clicks anywhere on the page.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.ranker button[data-rank]');
  if (!btn || btn.closest('.famranker')) return;
  e.preventDefault();
  const box = btn.closest('.ranker');
  const id = box.dataset.item;
  const item = state.byId.get(id);
  if (!item) return;
  const next = btn.dataset.rank === '' ? null : Number(btn.dataset.rank);
  // Tapping your current number does nothing, so a stray tap never erases a rank.
  if (next === myRank(item)) {
    toast(next == null ? 'Not ranked yet' : `Already ranked ${next}. Use "Clear my rank" to remove it.`);
    return;
  }
  box.querySelectorAll('button').forEach((b) => (b.disabled = true));
  savesInFlight++;
  try {
    const res = await state.api.setRank(id, next);
    // A background refresh may have replaced the item while we waited.
    const fresh = state.byId.get(id) || item;
    Object.assign(fresh, res);
    document.querySelectorAll(`.ranker[data-item="${CSS.escape(id)}"]`).forEach((el) => {
      el.outerHTML = rankerHtml(fresh, el.classList.contains('large'));
    });
    document.querySelectorAll(`[data-best="${CSS.escape(id)}"]`).forEach((el) => (el.innerHTML = bestLine(fresh)));
    if (currentRoute().name === 'item') renderWhoRanked(fresh);
    if (next == null && myTop().includes(id)) state.top10[String(state.me.id)] = myTop().filter((x) => x !== id);
    refreshTopLine();
    const prog = document.getElementById('progress');
    if (prog) prog.outerHTML = progressBar();
    toast(next == null ? 'Rank cleared' : `Ranked ${next}`);
  } catch (err) {
    if (!state.me) return; // signed out
    toast(err.message, true);
    box.querySelectorAll('button').forEach((b) => (b.disabled = false));
  } finally {
    savesInFlight--;
  }
});
let savesInFlight = 0;

// ------------------------------------------------------------------ browse

const FILTERS = 'fi_browse';
function loadFilters() {
  const blank = { q: '', room: '', type: '', mine: 'all', interest: 'all', sort: 'catalog', went: '' };
  try { return { ...blank, ...JSON.parse(getStored(FILTERS, 'sessionStorage') || '{}') }; }
  catch { return blank; }
}

function filteredItems(f) {
  const q = f.q.trim().toLowerCase();
  let list = state.items.filter((i) => {
    if (f.room && i.room !== f.room) return false;
    if (f.type && i.type !== f.type) return false;
    if (f.mine === 'unranked' && myRank(i) != null) return false;
    if (f.mine === 'ranked' && myRank(i) == null) return false;
    if (f.went && isPushed()) {
      if (f.went === 'mine' ? !wentMine(i) : f.went === 'other' ? (wentMine(i) || i.went_to == null) : i.went_to !== Number(f.went)) return false;
    }
    if (seesOthers()) { // people who rank don't get the interest filter (see seesOthers)
      const fams = Object.keys(i.family_best).length;
      if (f.interest === 'none' && fams > 0) return false;
      if (f.interest === 'some' && fams === 0) return false;
      if (f.interest === 'multi' && fams < 2) return false;
    }
    if (q && !`${i.name} ${i.id} ${i.room} ${i.type} ${i.subtype} ${i.description}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (f.sort === 'mine') list = [...list].sort((a, b) => (myRank(a) ?? 9) - (myRank(b) ?? 9));
  if (f.sort === 'wanted' && seesOthers()) list = [...list].sort((a, b) => (a.overall_best ?? 9) - (b.overall_best ?? 9)); // stable: ties stay in catalog order
  if (f.sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (f.sort === 'room') list = [...list].sort((a, b) => a.room.localeCompare(b.room)); // stable within a room
  return list;
}

// Shown on a person's first visit, until they close it.
function welcomeCard() {
  if (!canRank() || getStored('fi_welcomed') === '1') return '';
  return `
    <section class="welcome" id="welcome" aria-labelledby="welcome-h">
      <h2 id="welcome-h">Welcome, ${esc(state.me.name)}</h2>
      <ol>
        <li>Look through everything from the house. Tap a photo to see it larger.</li>
        <li>Under anything you would like, tap a number: <b>1</b> means you want it most, <b>5</b> means a little.</li>
        <li>Rank as many or as few as you like, and change them any time. Other people's ranks are kept off this page so you can rank with a clear mind. Your family's ranks are on My family.</li>
        <li>Your family's rank for an item starts as the lowest number anyone in your family gave. ${esc(familyName(state.me.family_id))} can adjust it.</li>
      </ol>
      <button type="button" class="btn" id="welcome-ok">Got it</button>
    </section>`;
}
document.addEventListener('click', (e) => {
  if (e.target.id !== 'welcome-ok') return;
  setStored('fi_welcomed', '1');
  document.getElementById('welcome')?.remove();
});

const firstUnranked = (after = null) => {
  const list = state.items;
  const start = after ? list.findIndex((i) => i.id === after) + 1 : 0;
  return [...list.slice(start), ...list.slice(0, start)].find((i) => myRank(i) == null && i.id !== after) || null;
};

function progressBar() {
  const done = state.items.filter((i) => myRank(i) != null).length;
  const next = firstUnranked();
  return `
    <div class="progress" id="progress">
      <span>You have ranked <b>${done}</b> of ${state.items.length} items.</span>
      ${next ? `<a class="btn ghost small" href="#/item/${esc(next.id)}">Next unranked item &rarr;</a>` : '<span>You have ranked everything.</span>'}
    </div>`;
}

function renderBrowse() {
  const f = loadFilters();
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  shell('browse', `
    <h1 class="page-title">The Collection</h1>
    <p class="page-sub">${canRank() && rankingOpen() ? 'Tap 1 to 5 under anything you would like. 1 means you want it most, 5 means a little.' : 'Browse everything in the house.'}</p>
    ${stageNotice()}
    ${rankingOpen() ? welcomeCard() : ''}
    ${canRank() && rankingOpen() ? progressBar() : ''}
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search by name, room or ID" value="${esc(f.q)}" data-f="q" aria-label="Search" />
      <div class="row">
        <select class="select" data-f="room" aria-label="Room">${opt('', 'All rooms', f.room)}${rooms().map((r) => opt(r, r, f.room)).join('')}</select>
        ${types().length ? `<select class="select" data-f="type" aria-label="Type">${opt('', 'All types', f.type)}${types().map((t) => opt(t, t, f.type)).join('')}</select>` : ''}
        ${canRank() ? `<select class="select" data-f="mine" aria-label="My ranks">${opt('all', 'Everything', f.mine)}${opt('unranked', 'Not yet ranked by me', f.mine)}${opt('ranked', 'Ranked by me', f.mine)}</select>` : ''}
        ${seesOthers() ? `<select class="select" data-f="interest" aria-label="Interest">${opt('all', 'Any interest', f.interest)}${opt('none', 'Nobody has ranked it', f.interest)}${opt('some', 'Someone wants it', f.interest)}${opt('multi', 'Wanted by 2+ families', f.interest)}</select>` : ''}
        ${isPushed() ? `<select class="select" data-f="went" aria-label="Went to">${opt('', 'Went to: any family', f.went)}${canRank() ? opt('mine', 'Went to my family', f.went) + opt('other', 'Went to another family', f.went) : ''}${state.families.map((fm) => opt(String(fm.id), `Went to ${fm.name}'s`, f.went)).join('')}</select>` : ''}
        <select class="select" data-f="sort" aria-label="Sort">${opt('catalog', 'Sort: catalog order', f.sort)}${opt('room', 'Sort: room', f.sort)}${opt('name', 'Sort: name A to Z', f.sort)}${seesOthers() ? opt('wanted', 'Sort: most wanted', f.sort) : ''}${canRank() ? opt('mine', 'Sort: my ranks first', f.sort) : ''}</select>
      </div>
    </div>
    <div class="count-row"><p class="count" id="count"></p><button type="button" class="link-btn" id="dl-photos">Download photos</button></div>
    <div class="grid" id="grid"></div>`);

  let shown = [];
  const draw = () => {
    if (!document.getElementById('grid')) return; // left the page before the search debounce fired
    const list = filteredItems(f);
    shown = list;
    document.getElementById('count').textContent = `${list.length} of ${state.items.length} items`;
    const dl = document.getElementById('dl-photos');
    if (!dl.dataset.busy) {
      dl.hidden = !list.length;
      dl.textContent = list.length === state.items.length ? 'Download all photos' : `Download photos of these ${list.length}`;
    }
    document.getElementById('grid').innerHTML = list.length
      ? list.map((i) => `
        <article class="card" data-id="${esc(i.id)}">
          <a class="photo" href="#/item/${esc(i.id)}">${thumbImg(i)}</a>
          <div class="meta">
            <div class="room">${esc(i.room)}</div>
            <a class="name" href="#/item/${esc(i.id)}">${esc(i.name)}</a>
            <div class="id-row"><span class="id">${esc(i.id)}</span>${canEdit() ? `<button type="button" class="link-btn edit-info" data-editinfo="${esc(i.id)}" aria-label="Edit info for ${esc(i.name)}">Edit info</button>` : ''}</div>
            <div class="best" data-best="${esc(i.id)}">${bestLine(i)}</div>
            ${isPushed() && i.went_to != null ? `<div class="went">${wentTag(i)}</div>` : ''}
            ${rankerHtml(i)}
          </div>
        </article>`).join('')
      : '<div class="empty-state"><p>Nothing matches your search and filters.</p><button type="button" class="btn ghost" id="clear-filters">Clear search and filters</button></div>';
  };
  draw();

  let t;
  app.querySelectorAll('[data-f]').forEach((el) =>
    el.addEventListener('input', () => {
      f[el.dataset.f] = el.value;
      setStored(FILTERS, JSON.stringify(f), 'sessionStorage');
      clearTimeout(t);
      t = setTimeout(draw, el.dataset.f === 'q' ? 150 : 0);
    }));
  document.getElementById('dl-photos').addEventListener('click', (e) => downloadPhotos(shown, e.currentTarget, f));
}

document.addEventListener('click', (e) => {
  if (e.target.id !== 'clear-filters') return;
  setStored(FILTERS, null, 'sessionStorage');
  renderBrowse();
});

window.addEventListener('scroll', () => {
  const name = currentRoute().name;
  if (name !== 'item') setStored(`fi_scroll_${name}`, String(window.scrollY), 'sessionStorage');
}, { passive: true });

// ------------------------------------------------------------------ item

const FIELDS = [
  ['name', 'Name'],
  ['type', 'Type'],
  ['subtype', 'Subtype'],
  ['origin', 'Origin'],
  ['description', 'Description'],
];

function renderWhoRanked(item) {
  const box = document.getElementById('who');
  if (!box) return;
  const shown = seesOthers() ? state.families : state.families.filter((f) => f.id === state.me.family_id);
  box.innerHTML = shown.map((f) => {
    const best = item.family_best[String(f.id)];
    const ranked = f.members.filter((m) => item.ranks[String(m.id)] != null);
    const top = seesOthers() && item.top_families.includes(f.id);
    const set = famSet(item, f.id);
    const mine = f.id === state.me.family_id;
    return `
      <div class="fam">
        <div class="fam-head"><strong>${esc(f.name)}'s family</strong>
          <span>${best != null ? `Family rank ${best}${top ? ' <span class="top-tag">· most wanted</span>' : ''}` : '<span style="color:var(--faint)">No ranks yet</span>'}</span></div>
        <ul>${ranked.length ? ranked.map((m) => `<li>${esc(m.name)} <b>${item.ranks[String(m.id)]}</b></li>`).join('') : ''}</ul>
        ${set ? `<p class="fr-note">${famSetNote(set)}</p>` : ''}
        ${mine && canSetFamilyRank() ? famRankerHtml(item) : ''}
      </div>`;
  }).join('');
}

// "Set by Susan. Automatically it would be 1."
function famSetNote(set) {
  return `Set by ${esc(set.by || 'a sibling')}. ${set.auto != null ? `Automatically it would be ${set.auto}.` : 'Nobody in the family has ranked it.'}`;
}

// The sibling's 1 to 5 buttons for the family rank, with Reset back to automatic.
function famRankerHtml(item) {
  const set = famSet(item, state.me.family_id);
  return `
    <div class="ranker famranker" data-item="${esc(item.id)}" role="group" aria-label="Family rank for ${esc(item.name)}">
      <span class="label">Adjust family rank <span class="hint">everyone's own ranks stay as they are</span></span>
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-rank="${n}" aria-pressed="${set?.rank === n}" aria-label="Family rank ${n}">${n}</button>`).join('')}
      ${set ? `<button type="button" class="clear" data-rank="">Reset to automatic${set.auto != null ? ` (${set.auto})` : ''}</button>` : ''}
    </div>`;
}

let familyRedraw = null; // the My family table's redraw, while that page is open
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.famranker button[data-rank]');
  if (!btn) return;
  e.preventDefault();
  const box = btn.closest('.famranker');
  const id = box.dataset.item;
  const item = state.byId.get(id);
  if (!item) return;
  const next = btn.dataset.rank === '' ? null : Number(btn.dataset.rank);
  if (next === (famSet(item, state.me.family_id)?.rank ?? null)) {
    toast(`The family rank is already ${next}`);
    return;
  }
  box.querySelectorAll('button').forEach((b) => (b.disabled = true));
  savesInFlight++;
  try {
    const res = await state.api.setFamilyRank(id, next);
    const fresh = state.byId.get(id) || item;
    Object.assign(fresh, res);
    if (currentRoute().name === 'item') renderWhoRanked(fresh);
    if (currentRoute().name === 'family') familyRedraw?.();
    const now = fresh.family_best[String(state.me.family_id)];
    toast(next == null ? `Back to automatic${now != null ? `: ${now}` : ''}` : `Family rank set to ${next}`);
  } catch (err) {
    if (!state.me) return;
    toast(err.message, true);
    box.querySelectorAll('button').forEach((b) => (b.disabled = false));
  } finally {
    savesInFlight--;
  }
});

// The item page's back link returns to the list the person came from.
const BACK_LABELS = { '#/': 'The collection', '#/family': 'My family', '#/results': 'Results', '#/admin': 'Admin' };
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#/item/"]');
  if (!a || currentRoute().name === 'item') return;
  const here = location.hash && BACK_LABELS[location.hash] ? location.hash : '#/';
  setStored('fi_from', here, 'sessionStorage');
});
function backLink() {
  const from = getStored('fi_from', 'sessionStorage') || '#/';
  return `<a class="back" href="${from}">&larr; ${BACK_LABELS[from] || 'The collection'}</a>`;
}

function renderItem(id) {
  const item = state.byId.get(id);
  if (!item) {
    shell('browse', '<p class="empty-state">That item was not found. <a href="#/">Back to the collection</a></p>');
    return;
  }
  const list = filteredItems(loadFilters());
  const idx = list.findIndex((i) => i.id === id);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;
  let current = 0;

  shell('browse', `
    ${backLink()}
    <div class="item-page">
      <div>
        <div class="stage" id="stage"></div>
        ${item.photos.length > 1 ? `<div class="thumbs" id="thumbs">${item.photos.map((p, n) => `<button type="button" data-n="${n}" aria-label="Photo ${n + 1}">${p.thumb ? `<img src="${esc(p.thumb)}" alt="" />` : ''}</button>`).join('')}</div>` : ''}
        <div class="pager">
          ${prev ? `<a href="#/item/${esc(prev.id)}">&larr; Previous</a>` : '<span></span>'}
          ${canRank() && firstUnranked(item.id) ? `<a href="#/item/${esc(firstUnranked(item.id).id)}">Next unranked</a>` : ''}
          ${next ? `<a href="#/item/${esc(next.id)}">Next &rarr;</a>` : '<span></span>'}
        </div>
      </div>
      <div>
        <div class="eyebrow">${esc(item.room)}${item.photo_no ? ` · Photo ${esc(item.photo_no)}` : ''} · ${esc(item.id)}</div>
        <h1 class="item-title" id="title">${esc(item.name)}</h1>
        ${wentLineHtml(item)}
        <div class="best" data-best="${esc(item.id)}">${bestLine(item)}</div>
        ${canRank() ? `<div class="top-line" id="top-line" data-item="${esc(item.id)}">${topLineHtml(item)}</div>` : ''}
        ${canRank() ? `<div class="rank-box">${rankerHtml(item, true)}</div>` : ''}
        <dl class="facts" id="facts"></dl>
        ${canEdit() ? `<p class="edit-row"><button type="button" class="btn ghost small" data-editinfo="${esc(item.id)}">Edit info</button></p>` : ''}
        <h2 class="section-title">${seesOthers() ? 'Who wants it' : 'Your family'}</h2>
        <div class="who-ranked" id="who"></div>
        <h2 class="section-title">Edit history</h2>
        <button type="button" class="link-btn" id="show-history">Show changes</button>
        <ul class="history" id="history" hidden></ul>
        ${state.me.is_admin ? `
          <h2 class="section-title">Admin</h2>
          <button type="button" class="btn ghost small" id="remove-item">Remove from website</button>
          <p class="admin-note">Takes it off the website for everyone, you included. It stays in the database, and you can put it back from the Admin page.</p>
          ${photoOf(item)?.drive ? `<p style="font-size:13px"><a href="${esc(photoOf(item).drive)}" target="_blank" rel="noopener">Original photo in Google Drive</a></p>` : ''}` : ''}
      </div>
    </div>`);

  const drawStage = () => {
    const p = item.photos[current];
    document.getElementById('stage').innerHTML = p?.full
      ? `<img src="${esc(p.full)}" alt="${esc(item.name)}" />`
      : '<div class="placeholder">Photo coming</div>';
    document.querySelectorAll('#thumbs button').forEach((b) => b.setAttribute('aria-current', String(Number(b.dataset.n) === current)));
  };
  drawStage();
  document.getElementById('thumbs')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-n]');
    if (b) { current = Number(b.dataset.n); drawStage(); }
  });
  document.getElementById('stage').addEventListener('click', () => {
    if (item.photos[current]?.full) openLightbox(item, current, (n) => { current = n; drawStage(); });
  });

  // Swipe left/right on the photo to move between items.
  let sx = null;
  const stage = document.getElementById('stage');
  let sy = null;
  stage.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX < 24 ? null : t.clientX; // leave the screen edge to the browser's Back swipe
    sy = t.clientY;
  }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    sx = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) < 2 * Math.abs(dy)) return; // mostly sideways only
    const target = dx < 0 ? next : prev;
    if (target) location.hash = `#/item/${target.id}`;
  });

  const drawFacts = () => {
    document.getElementById('facts').innerHTML = FIELDS.map(([f, label]) => `
      <div class="fact" data-field="${f}">
        <dt>${label}</dt>
        <dd class="${item[f] ? '' : 'empty'}">${item[f] ? esc(item[f]) : 'Not filled in'}</dd>
      </div>`).join('');
  };
  drawFacts();

  const loadHistory = async () => {
    const ul = document.getElementById('history');
    ul.hidden = false;
    ul.innerHTML = '<li class="loading">Loading…</li>';
    try {
      rows = await state.api.history(item.id);
      ul.innerHTML = rows.length ? rows.map(historyRow).join('') : '<li>No changes yet.</li>';
    } catch (err) {
      ul.innerHTML = `<li>${esc(err.message)}</li>`;
    }
  };
  let rows = [];
  const label = (field) => (FIELDS.find(([k]) => k === field)?.[1] || field).toLowerCase();
  // Each change, with Restore for editors when the earlier value differs from today's.
  const historyRow = (r) => {
    if (r.field === 'hidden') {
      return `<li><b>${esc(r.by)}</b> ${r.new === 'true' ? 'removed this item from the website' : 'put this item back on the website'} on ${esc(fmtDate(r.at))}</li>`;
    }
    const restorable = canEdit() && FIELDS.some(([k]) => k === r.field) && (r.old ?? '') !== (item[r.field] ?? '')
      && !(r.field === 'name' && !(r.old ?? '').trim());
    return `<li><b>${esc(r.by)}</b> changed the ${esc(label(r.field))} on ${esc(fmtDate(r.at))}<br>from “${esc(r.old || '—')}” to “${esc(r.new || '—')}”
      ${restorable ? `<button type="button" class="link-btn restore" data-restore="${esc(r.id)}">Restore “${esc(clip(r.old || '—'))}”</button>` : ''}</li>`;
  };
  document.getElementById('show-history').addEventListener('click', (e) => { e.target.remove(); loadHistory(); });
  document.getElementById('history').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-restore]');
    if (!b) return;
    const r = rows.find((x) => String(x.id) === b.dataset.restore);
    if (!r || !confirmInline(b, `Tap again to change the ${label(r.field)} back to “${clip(r.old || '—')}”.`)) return;
    b.disabled = true;
    try {
      const res = await state.api.editItem(item.id, r.field, r.old ?? '', item[r.field] ?? '');
      item[r.field] = res.value;
      document.getElementById('title').textContent = item.name;
      drawFacts();
      toast(res.conflict ? `${res.by || 'Someone'} changed it just now. Check the history, then try again.` : 'Restored', !!res.conflict);
      loadHistory();
    } catch (err) {
      if (!state.me) return;
      toast(err.message, true);
      b.disabled = false;
    }
  });

  document.getElementById('remove-item')?.addEventListener('click', async (e) => {
    if (!confirmInline(e.target, `Tap again to remove ${item.name} from the website.`)) return;
    e.target.disabled = true;
    try {
      await state.api.adminSetHidden(item.id, true);
      state.items = state.items.filter((i) => i.id !== item.id);
      state.byId.delete(item.id);
      toast(`${item.id} removed. Put it back any time from the Admin page.`);
      location.hash = '#/';
    } catch (err) { toast(err.message, true); e.target.disabled = false; }
  });

  renderWhoRanked(item);
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ edit info
//
// The admin and the siblings edit an item's details from Browse (the Edit info
// link on each card) or from the item page. Every change goes into the item's
// edit history, where it can be restored.

const clip = (t, n = 40) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-editinfo]');
  if (!b) return;
  const item = state.byId.get(b.dataset.editinfo);
  if (item) openEditor(item, b);
});

function openEditor(item, opener) {
  if (!canEdit()) return;
  document.querySelector('.edit-modal')?.remove();
  const p = photoOf(item);
  const box = document.createElement('div');
  box.className = 'edit-modal';
  box.innerHTML = `
    <div class="edit-sheet" role="dialog" aria-modal="true" aria-labelledby="edit-h">
      <div class="edit-head">
        <h2 id="edit-h">Edit info</h2>
        <button type="button" class="close" data-close aria-label="Close">&times;</button>
      </div>
      <div class="fill-item">
        <div class="fill-photo">${p?.full ? `<img src="${esc(p.full)}" alt="${esc(item.name)}" />` : '<div class="placeholder">Photo coming</div>'}</div>
        <form class="fill-form" autocomplete="off">
          <div class="eyebrow">${esc(item.room)}${item.photo_no ? ` · Photo ${esc(item.photo_no)}` : ''} · ${esc(item.id)}</div>
          <label>Name<input class="input" name="name" value="${esc(item.name)}" /></label>
          <label class="fill-type">Type${typeSelectHtml(item.type)}</label>
          <label class="fill-type">Subtype${subtypeSelectHtml(item.subtype, item.type)}</label>
          <label>Origin<input class="input" name="origin" value="${esc(item.origin)}" placeholder="Where it came from, who made it" /></label>
          <label>Description<textarea class="input" name="description" rows="4">${esc(item.description)}</textarea></label>
          <p class="conflict-note" hidden></p>
          <p class="edit-foot">Every change is kept in the item's edit history, so it can be restored.</p>
          <div class="fill-actions">
            <button type="submit" class="btn">Save</button>
            <button type="button" class="btn ghost" data-close>Cancel</button>
          </div>
        </form>
      </div>
    </div>`;
  const close = () => {
    box.remove();
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', onKey);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  box.addEventListener('click', (e) => { if (e.target === box || e.target.closest('[data-close]')) close(); });
  document.addEventListener('keydown', onKey);
  document.body.append(box);
  document.body.classList.add('modal-open');
  const form = box.querySelector('form');
  form.querySelector('[name="name"]').focus({ preventScroll: true });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type="submit"]');
    const note = form.querySelector('.conflict-note');
    const want = {
      name: form.elements.namedItem('name').value.trim(),
      type: typeValue(form),
      subtype: pickValue(form, 'subtype'),
      origin: form.elements.namedItem('origin').value.trim(),
      description: form.elements.namedItem('description').value.trim(),
    };
    if (!want.name) want.name = item.name; // a blank name keeps the old one
    btn.disabled = true;
    let changed = 0;
    try {
      for (const [k, v] of Object.entries(want)) {
        if (v === (item[k] || '')) continue;
        const res = await state.api.editItem(item.id, k, v, item[k] || '');
        item[k] = res.value;
        if (res.conflict) {
          // Someone else saved first: show their version and let this person decide.
          note.hidden = false;
          note.textContent = `${res.by || 'Someone'} changed the ${k} while you were working. It now says “${res.value || '—'}”. Check it, then tap Save again.`;
          const field = k === 'type' || k === 'subtype' ? null : form.querySelector(`[name="${k}"]`);
          if (field) field.value = res.value || '';
          btn.disabled = false;
          return;
        }
        changed++;
      }
      close();
      toast(changed ? 'Saved' : 'Nothing changed');
      if (changed) afterEdit(item);
    } catch (err) {
      if (state.me) toast(err.message, true);
      btn.disabled = false;
    }
  });
}

// Show an edit without losing the person's place on the page.
function afterEdit(item) {
  if (currentRoute().name === 'item') {
    const y = window.scrollY;
    const historyOpen = document.getElementById('history')?.hidden === false;
    renderItem(item.id);
    window.scrollTo(0, y);
    if (historyOpen) document.getElementById('show-history')?.click();
    return;
  }
  document.querySelectorAll(`.card[data-id="${CSS.escape(item.id)}"]`).forEach((card) => {
    card.querySelector('.name').textContent = item.name;
    card.querySelector('.photo img')?.setAttribute('alt', item.name);
  });
}

// ------------------------------------------------------------------ photo download
//
// Saves the full-size photos of the items on screen (after search and filters)
// as one zip file, named by item ID and name.

const safeName = (t) => t.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '');

async function downloadPhotos(list, btn, f) {
  if (btn.dataset.busy) return;
  const nPhotos = list.reduce((n, i) => n + i.photos.filter((p) => p.full).length, 0);
  if (!nPhotos) { toast('These items have no photos yet'); return; }
  if (!confirmInline(btn, `Tap again to save ${nPhotos} photo${nPhotos === 1 ? '' : 's'} (about ${Math.max(1, Math.round(nPhotos * 0.09))} MB) as one zip file.`)) return;
  btn.dataset.busy = '1';
  const label = btn.textContent;
  try {
    btn.textContent = 'Getting photos…';
    // Photo links expire, so ask for fresh ones first.
    const fresh = new Map((await state.api.load()).items.map((i) => [i.id, i]));
    const jobs = [];
    for (const it of list) {
      const photos = (fresh.get(it.id) || it).photos.filter((p) => p.full);
      photos.forEach((p, n) => jobs.push({ url: p.full, base: `${it.id} ${safeName(it.name)}${photos.length > 1 ? ` - photo ${n + 1}` : ''}` }));
    }
    const files = new Array(jobs.length);
    let done = 0;
    let failed = 0;
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const j = next++;
        let data = null;
        let type = '';
        for (let attempt = 0; attempt < 2 && !data; attempt++) {
          try {
            const r = await fetch(jobs[j].url);
            if (r.ok) { type = r.headers.get('content-type') || ''; data = new Uint8Array(await r.arrayBuffer()); }
          } catch { /* try once more */ }
        }
        if (data) files[j] = { name: `${jobs[j].base}.${/png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : 'jpg'}`, data };
        else failed++;
        done++;
        btn.textContent = `Getting photos… ${done} of ${jobs.length}`;
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    const ok = files.filter(Boolean);
    if (!ok.length) throw new Error('The photos could not be downloaded. Check your connection and try again.');
    const what = f.type ? safeName(f.type).toLowerCase() : f.room ? safeName(f.room).toLowerCase() : list.length === state.items.length ? 'all' : 'selected';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(makeZip(ok));
    a.download = `family-inventory-photos-${what.replace(/ /g, '-')}-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    toast(failed ? `Saved ${ok.length} photos. ${failed} could not be downloaded; try again for those.` : `Saved ${ok.length} photo${ok.length === 1 ? '' : 's'}`, !!failed);
  } catch (err) {
    if (state.me) toast(err.message, true);
  } finally {
    delete btn.dataset.busy;
    btn.textContent = label;
  }
}

function openLightbox(item, start, onChange) {
  let n = start;
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', item.name);
  const draw = () => {
    box.innerHTML = `
      <img src="${esc(item.photos[n].full)}" alt="${esc(item.name)}" />
      <button type="button" class="close" aria-label="Close">&times;</button>
      ${item.photos.length > 1 ? '<button type="button" class="prev" aria-label="Previous photo">&lsaquo;</button><button type="button" class="next" aria-label="Next photo">&rsaquo;</button>' : ''}`;
  };
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey); onChange(n); };
  const step = (d) => { n = (n + d + item.photos.length) % item.photos.length; draw(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowLeft') step(-1); if (e.key === 'ArrowRight') step(1); };
  box.addEventListener('click', (e) => {
    if (e.target.closest('.prev')) step(-1);
    else if (e.target.closest('.next')) step(1);
    else if (e.target.closest('.close') || e.target === box) close();
  });
  document.addEventListener('keydown', onKey);
  draw();
  document.body.append(box);
}

// ------------------------------------------------------------------ my family

function rankCell(r) {
  return r == null ? '' : `<span class="rank-pill r${r}">${r}</span>`;
}

function miniItem(i) {
  const p = photoOf(i);
  return `<a class="mini" href="#/item/${esc(i.id)}">${p?.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy" />` : '<span class="ph"></span>'}
    <span><span class="t">${esc(i.name)}</span><br><span class="s">${esc(i.room)}&nbsp;· <span class="nw">${esc(i.id)}</span></span></span></a>`;
}

// Search, room and type filters shared by the My family and Results tables.
const matchesQuery = (i, q) => !q || `${i.name} ${i.id} ${i.room} ${i.type} ${i.subtype} ${i.description}`.toLowerCase().includes(q);
const SORTS = {
  catalog: () => 0,
  room: (a, b) => a.room.localeCompare(b.room),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
};

function tableToolbar(f, extra) {
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  return `
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search by name, room or ID" value="${esc(f.q)}" data-f="q" aria-label="Search" />
      <div class="row">
        ${extra(opt)}
        <select class="select" data-f="room" aria-label="Room">${opt('', 'All rooms', f.room)}${rooms().map((r) => opt(r, r, f.room)).join('')}</select>
        ${types().length ? `<select class="select" data-f="type" aria-label="Type">${opt('', 'All types', f.type)}${types().map((t) => opt(t, t, f.type)).join('')}</select>` : ''}
      </div>
    </div>`;
}

function wireToolbar(f, storeKey, draw) {
  let t;
  app.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', () => {
    f[el.dataset.f] = el.value;
    setStored(storeKey, JSON.stringify(f), 'sessionStorage');
    clearTimeout(t);
    t = setTimeout(draw, el.dataset.f === 'q' ? 150 : 0);
  }));
}

function loadView(key, blank) {
  try { return { ...blank, ...JSON.parse(getStored(key, 'sessionStorage') || '{}') }; } catch { return { ...blank }; }
}

function renderFamily() {
  const fam = state.families.find((f) => f.id === state.me.family_id);
  if (!fam) {
    shell('family', `<h1 class="page-title">My family</h1><p class="page-sub">You are not part of a sibling family, so there is nothing to show here. See Results for everyone.</p>`);
    return;
  }
  const f = loadView('fi_family', { q: '', room: '', type: '', who: 'any', sort: 'best', went: '' });
  shell('family', `
    <h1 class="page-title">${esc(fam.name)}'s family</h1>
    <p class="page-sub">${isPushed() ? 'What your family received, your top 10s, and everything your family ranked.' : 'Your top 10, your family\'s top 10s, and everything your family has ranked.'}</p>
    ${stageNotice()}
    ${canRank() ? myTopHtml() : ''}
    ${(() => { const t = familyTopsHtml(fam); return t ? `<section class="family-tops"><div class="top10-head"><h2 class="section-title">Your family's top 10s</h2><p class="top10-note">The family top 10 adds up everyone's lists: 1st place is worth 10 points, 10th is worth 1.</p></div>${t}</section>` : ''; })()}
    <h2 class="section-title">Everything your family ranked</h2>
    <p class="table-note">The family rank starts as the lowest number any of you gave. ${esc(fam.name)} can adjust it${canSetFamilyRank() ? ': tap a family rank to change it' : ''}. “Set” marks a rank ${esc(fam.name)} adjusted.${isPushed() ? ' Went to shows which family each item was given to.' : ''}</p>
    ${tableToolbar(f, (opt) => `
      <select class="select" data-f="who" aria-label="Show">${opt('any', 'Ranked by anyone in the family', f.who)}${opt('me', 'Ranked by me', f.who)}${fam.members.filter((m) => m.id !== state.me.id).map((m) => opt(String(m.id), `Ranked by ${m.name}`, f.who)).join('')}${opt('notme', 'Family ranked, I have not', f.who)}${opt('all', 'All items', f.who)}</select>
      ${isPushed() ? `<select class="select" data-f="went" aria-label="Went to">${opt('', 'Went to: any family', f.went)}${opt('mine', 'Went to my family', f.went)}${opt('other', 'Went to another family', f.went)}</select>` : ''}
      <select class="select" data-f="sort" aria-label="Sort">${opt('best', 'Sort: family rank', f.sort)}${opt('mine', 'Sort: my rank', f.sort)}${opt('catalog', 'Sort: catalog order', f.sort)}${opt('room', 'Sort: room', f.sort)}${opt('name', 'Sort: name A to Z', f.sort)}</select>`)}
    <p class="count" id="count"></p>
    <div class="table-wrap"><table class="data" id="tbl"></table></div>`);

  const famRanked = (i) => i.family_best[String(fam.id)] != null || fam.members.some((m) => i.ranks[String(m.id)] != null);
  let open = null; // the item whose family rank buttons are showing
  const famCell = (i) => {
    const best = i.family_best[String(fam.id)];
    const set = famSet(i, fam.id);
    const inner = `${rankCell(best) || '<span class="dash">–</span>'}${set ? '<span class="fr-set">set</span>' : ''}`;
    return canSetFamilyRank()
      ? `<td class="num key fr"><button type="button" class="fr-btn" data-fr="${esc(i.id)}" aria-expanded="${open === i.id}" aria-label="Family rank for ${esc(i.name)}: ${best ?? 'none'}${set ? `, set by ${esc(set.by)}` : ''}. Tap to adjust." ${set ? `title="Set by ${esc(set.by)}"` : ''}>${inner}</button></td>`
      : `<td class="num key fr" ${set ? `title="Set by ${esc(set.by)}"` : ''}>${inner}</td>`;
  };
  const draw = () => {
    if (!document.getElementById('tbl')) return;
    const q = f.q.trim().toLowerCase();
    let rows = state.items.filter((i) => {
      if (f.room && i.room !== f.room) return false;
      if (f.type && i.type !== f.type) return false;
      if (!matchesQuery(i, q)) return false;
      if (isPushed() && f.went === 'mine' && !wentMine(i)) return false;
      if (isPushed() && f.went === 'other' && (wentMine(i) || i.went_to == null)) return false;
      if (f.who === 'any') return famRanked(i);
      if (f.who === 'me') return myRank(i) != null;
      if (f.who === 'notme') return famRanked(i) && myRank(i) == null;
      if (f.who === 'all') return true;
      return i.ranks[f.who] != null;
    });
    const best = (i) => i.family_best[String(fam.id)] ?? 9;
    if (f.sort === 'best') rows = [...rows].sort((a, b) => best(a) - best(b));
    else if (f.sort === 'mine') rows = [...rows].sort((a, b) => (myRank(a) ?? 9) - (myRank(b) ?? 9));
    else rows = [...rows].sort(SORTS[f.sort] || SORTS.catalog);
    const got = isPushed() ? rows.filter(wentMine).length : 0;
    document.getElementById('count').textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}${isPushed() ? ` · ${got} went to your family` : ''}`;
    const wentTh = isPushed() ? '<th class="went">Went to</th>' : '';
    const wentTd = (i) => (isPushed() ? `<td class="went">${wentTag(i) || '<span class="wtag none">–</span>'}</td>` : '');
    document.getElementById('tbl').innerHTML = `
      <thead><tr><th>Item</th>${wentTh}<th class="num key">Family rank</th>${fam.members.map((m) => `<th class="num ${m.id === state.me.id ? 'me-col' : ''}">${m.id === state.me.id ? 'You' : esc(m.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((i) => `<tr><td class="item-cell">${miniItem(i)}</td>${wentTd(i)}${famCell(i)}${fam.members.map((m) => `<td class="num ${m.id === state.me.id ? 'me-col' : ''}">${rankCell(i.ranks[String(m.id)])}</td>`).join('')}</tr>${open === i.id && canSetFamilyRank() ? `<tr class="fr-row"><td colspan="${fam.members.length + (isPushed() ? 3 : 2)}">${famRankerHtml(i)}${famSet(i, fam.id) ? `<p class="fr-note">${famSetNote(famSet(i, fam.id))}</p>` : ''}</td></tr>` : ''}`).join('')
        || `<tr><td colspan="${fam.members.length + (isPushed() ? 3 : 2)}" class="empty-state">Nothing matches. Try another filter.</td></tr>`}</tbody>`;
  };
  draw();
  familyRedraw = draw;
  document.getElementById('tbl').addEventListener('click', (e) => {
    const b = e.target.closest('[data-fr]');
    if (!b) return;
    open = open === b.dataset.fr ? null : b.dataset.fr;
    draw();
    document.querySelector(`[data-fr="${CSS.escape(b.dataset.fr)}"]`)?.focus({ preventScroll: true });
  });
  wireToolbar(f, 'fi_family', draw);
  wireMyTop();
}

// ------------------------------------------------------------------ top 10

// Each family member keeps an ordered top 10 of items they have ranked.
// state.top10 = { personId: [itemId, ...] } holds the lists this person may see.
const TOP_N = 10;
const myTop = () => [...(state.top10[String(state.me.id)] || [])];
const topItems = (ids) => ids.map((id) => state.byId.get(id)).filter(Boolean);

async function saveTop(ids, msg) {
  const before = myTop();
  state.top10[String(state.me.id)] = ids;
  drawMyTop();
  refreshTopLine();
  try {
    const saved = await state.api.setTop10(ids);
    state.top10[String(state.me.id)] = saved;
    if (msg) toast(msg);
  } catch (err) {
    if (!state.me) return;
    state.top10[String(state.me.id)] = before;
    drawMyTop();
    refreshTopLine();
    toast(err.message, true);
  }
}

function topThumb(i) {
  const p = photoOf(i);
  return p?.thumb ? `<img src="${esc(p.thumb)}" alt="" loading="lazy" />` : '<span class="ph"></span>';
}

// "Your top 10": ten numbered places. Drag the handle (or use the arrows) to reorder.
function myTopHtml() {
  return `
    <section class="top10" aria-labelledby="top10-h">
      <div class="top10-head">
        <h2 class="section-title" id="top10-h">Your top 10</h2>
        <p class="top10-note" id="top10-note">${topNote()}</p>
      </div>
      <ol class="slots" id="my-slots"></ol>
      <div class="picker" id="top-picker" hidden>
        <div class="picker-head">
          <input class="input" type="search" id="picker-q" placeholder="Search the things you ranked" aria-label="Search the things you ranked" />
          <button type="button" class="link-btn" id="picker-close">Close</button>
        </div>
        <ul class="picker-list" id="picker-list"></ul>
      </div>
    </section>`;
}

function topNote() {
  if (isPushed()) {
    const items = topItems(myTop());
    return `Your family got <b>${items.filter(wentMine).length} of your top ${items.length || 10}</b>.`;
  }
  if (!rankingOpen()) return 'Ranking is closed, so your top 10 is locked.';
  return 'Your family and the admin can see this. Drag <span aria-hidden="true">⠿</span> to reorder.';
}

function drawMyTop() {
  const box = document.getElementById('my-slots');
  if (!box) return;
  const items = topItems(myTop());
  const locked = !rankingOpen();
  box.classList.toggle('locked', locked);
  const rows = [];
  for (let n = 1; n <= TOP_N; n++) {
    const i = items[n - 1];
    if (i && locked) {
      rows.push(`
        <li class="slot filled${goneClass(i)}" data-id="${esc(i.id)}">
          <span class="n">${n}</span>
          <a class="slot-item" href="#/item/${esc(i.id)}">${topThumb(i)}
            <span><span class="t">${esc(i.name)}</span><span class="s">Your rank ${myRank(i) ?? '–'} · ${esc(i.room)}</span></span></a>
          ${gotTag(i)}
        </li>`);
    } else if (!i && locked) {
      rows.push(`
        <li class="slot empty">
          <span class="n">${n}</span>
          <span class="slot-item"><span class="ph"></span><span class="s">Empty</span></span>
        </li>`);
    } else if (i) {
      rows.push(`
        <li class="slot filled" data-id="${esc(i.id)}">
          <button type="button" class="handle" aria-label="Drag ${esc(i.name)} to a new place" title="Drag to reorder"><span aria-hidden="true">⠿</span></button>
          <span class="n">${n}</span>
          <a class="slot-item" href="#/item/${esc(i.id)}">${topThumb(i)}
            <span><span class="t">${esc(i.name)}</span><span class="s">Your rank ${myRank(i) ?? '–'} · ${esc(i.room)}</span></span></a>
          <span class="slot-tools">
            <button type="button" class="sq" data-move="-1" aria-label="Move ${esc(i.name)} up" ${n === 1 ? 'disabled' : ''}>↑</button>
            <button type="button" class="sq" data-move="1" aria-label="Move ${esc(i.name)} down" ${n === items.length ? 'disabled' : ''}>↓</button>
            <button type="button" class="sq x" data-remove aria-label="Take ${esc(i.name)} out of your top 10">×</button>
          </span>
        </li>`);
    } else {
      rows.push(`
        <li class="slot empty">
          <span class="handle-space"></span>
          <span class="n">${n}</span>
          <span class="slot-item"><span class="ph"></span><span class="s">Empty</span></span>
          ${n === items.length + 1 ? '<button type="button" class="btn ghost small" data-add>Add</button>' : ''}
        </li>`);
    }
  }
  box.innerHTML = rows.join('');
}

function drawPicker() {
  const list = document.getElementById('picker-list');
  if (!list) return;
  const q = document.getElementById('picker-q').value.trim().toLowerCase();
  const inTop = new Set(myTop());
  const cands = state.items
    .filter((i) => myRank(i) != null && !inTop.has(i.id) && !i.hidden && matchesQuery(i, q))
    .sort((a, b) => myRank(a) - myRank(b) || SORTS.catalog(a, b));
  list.innerHTML = cands.length
    ? cands.map((i) => `
      <li><span class="slot-item">${topThumb(i)}<span><span class="t">${esc(i.name)}</span><span class="s">Your rank ${myRank(i)} · ${esc(i.room)} · ${esc(i.id)}</span></span></span>
        <button type="button" class="btn ghost small" data-pick="${esc(i.id)}">Add</button></li>`).join('')
    : `<li class="empty-state">${q ? 'Nothing you ranked matches.' : 'Everything you ranked is already in your top 10. Rank more items on Browse to add them.'}</li>`;
}

function wireMyTop() {
  const box = document.getElementById('my-slots');
  if (!box) return;
  drawMyTop();
  const picker = document.getElementById('top-picker');
  const openPicker = () => {
    picker.hidden = false;
    document.getElementById('picker-q').value = '';
    drawPicker();
    document.getElementById('picker-q').focus({ preventScroll: true });
    picker.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-add]')) return openPicker();
    const row = e.target.closest('.slot.filled');
    if (!row) return;
    const ids = myTop();
    const at = ids.indexOf(row.dataset.id);
    const mv = e.target.closest('[data-move]');
    if (mv) {
      const to = at + Number(mv.dataset.move);
      if (to < 0 || to >= ids.length) return;
      ids.splice(to, 0, ids.splice(at, 1)[0]);
      saveTop(ids).then(() => document.querySelector(`.slot[data-id="${CSS.escape(row.dataset.id)}"] [data-move="${mv.dataset.move}"]:not(:disabled)`)?.focus());
      return;
    }
    if (e.target.closest('[data-remove]')) {
      ids.splice(at, 1);
      saveTop(ids, 'Taken out of your top 10');
    }
  });
  document.getElementById('picker-close').addEventListener('click', () => { picker.hidden = true; });
  document.getElementById('picker-q').addEventListener('input', drawPicker);
  document.getElementById('picker-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    const ids = myTop();
    if (ids.length >= TOP_N) { toast('Your top 10 is full. Take one out first.', true); return; }
    ids.push(b.dataset.pick);
    saveTop(ids, `Added as number ${ids.length}`);
    if (ids.length >= TOP_N) picker.hidden = true; else drawPicker();
  });
  wireDrag(box);
}

// Drag to reorder, for mouse and touch alike (pointer events on the handle only,
// so the page still scrolls normally everywhere else).
function wireDrag(box) {
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.handle');
    if (!handle || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const row = handle.closest('.slot.filled');
    const rows = [...box.querySelectorAll('.slot.filled')];
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const tops = rows.map((r) => r.getBoundingClientRect().top + window.scrollY);
    const h = row.getBoundingClientRect().height;
    drag = { handle, row, rows, tops, h, from: rows.indexOf(row), to: rows.indexOf(row), startY: e.clientY + window.scrollY, y: e.clientY };
    row.classList.add('dragging');
    box.classList.add('sorting');
  });
  const move = () => {
    if (!drag) return;
    const pageY = drag.y + window.scrollY;
    const dy = pageY - drag.startY;
    drag.row.style.transform = `translateY(${dy}px)`;
    const centre = drag.tops[drag.from] + dy + drag.h / 2;
    let to = drag.from;
    drag.tops.forEach((t, k) => {
      const mid = t + drag.h / 2;
      if (k < drag.from && centre < mid) to = Math.min(to, k);
      if (k > drag.from && centre > mid) to = Math.max(to, k);
    });
    drag.to = to;
    drag.rows.forEach((r, k) => {
      if (r === drag.row) return;
      let shift = 0;
      if (drag.from < to && k > drag.from && k <= to) shift = -drag.h;
      if (drag.from > to && k >= to && k < drag.from) shift = drag.h;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  let raf = 0;
  const autoscroll = () => {
    if (!drag) return;
    const edge = 70;
    const v = drag.y < edge ? -(edge - drag.y) / 4 : drag.y > innerHeight - edge ? (drag.y - (innerHeight - edge)) / 4 : 0;
    if (v) { window.scrollBy(0, v); move(); }
    raf = requestAnimationFrame(autoscroll);
  };
  box.addEventListener('pointermove', (e) => {
    if (!drag) return;
    drag.y = e.clientY;
    if (!raf) raf = requestAnimationFrame(autoscroll);
    move();
  });
  const end = () => {
    if (!drag) return;
    cancelAnimationFrame(raf); raf = 0;
    const { from, to, rows } = drag;
    rows.forEach((r) => { r.style.transform = ''; });
    drag.row.classList.remove('dragging');
    box.classList.remove('sorting');
    drag = null;
    if (from === to) return;
    const ids = myTop();
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    saveTop(ids, `Moved to number ${to + 1}`);
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('lostpointercapture', end);
}

// A read-only numbered strip of someone's top 10.
function topStripHtml(person, ids, sharedSet) {
  const items = topItems(ids);
  const isMe = state.me && person.id === state.me.id;
  const places = [];
  for (let k = 0; k < TOP_N; k++) {
    const i = items[k];
    places.push(i ? `
        <li class="${goneClass(i).trim()}"><a href="#/item/${esc(i.id)}">
          <span class="ph-box">${topThumb(i)}<span class="badge">${k + 1}</span></span>
          <span class="txt"><span class="t">${esc(i.name)}</span>${gotTag(i)}</span>
          ${sharedSet && sharedSet.has(i.id) ? '<span class="shared">Shared pick</span>' : ''}
        </a></li>` : `
        <li class="none"><span class="ph-box"><span class="ph"></span><span class="badge">${k + 1}</span></span><span class="t">Not picked</span></li>`);
  }
  return `
    <div class="strip-wrap${isMe ? ' me' : ''}${items.length ? '' : ' blank'}">
      <h3 class="strip-title">${isMe ? 'You' : esc(person.name)} <span class="s">${isPushed() && canRank() && items.length
        ? `got <b>${items.filter(wentMine).length}</b> of ${items.length}`
        : items.length === TOP_N ? '' : items.length ? `${items.length} of 10 picked` : 'Nothing picked yet'}</span></h3>
      <ol class="strip">${places.join('')}</ol>
    </div>`;
}

// Items that two or more people in a group put in their top 10.
function sharedPicks(people) {
  const count = new Map();
  for (const p of people) for (const id of state.top10[String(p.id)] || []) count.set(id, (count.get(id) || 0) + 1);
  return new Set([...count].filter(([, n]) => n > 1).map(([id]) => id));
}

// The family top 10, worked out from everyone's lists: 1st place is worth 10 points,
// 10th is worth 1, and points add up across the family. Ties go to the item someone
// placed higher, then to the item more people picked, then to catalog order.
function familyTop(fam, limit = TOP_N) {
  const score = new Map();
  for (const m of fam.members) {
    (state.top10[String(m.id)] || []).forEach((id, k) => {
      if (!state.byId.has(id)) return;
      const e = score.get(id) || { id, pts: 0, best: 99, who: [] };
      e.pts += TOP_N - k; e.best = Math.min(e.best, k + 1); e.who.push({ person: m, place: k + 1 });
      score.set(id, e);
    });
  }
  const order = (id) => state.items.indexOf(state.byId.get(id));
  return [...score.values()]
    .sort((a, b) => b.pts - a.pts || a.best - b.best || b.who.length - a.who.length || order(a.id) - order(b.id))
    .slice(0, limit);
}

// After the push, the family column says where each item went, on the same line as who picked it.
function famGot(i) {
  if (!isPushed() || i.went_to == null) return '';
  if (canRank() && wentMine(i)) return ' · <b class="got-mine">✓ Yours</b>';
  return ` · Went to ${esc(famShort(i.went_to))}`;
}

function familyStripHtml(fam, title = 'Family top 10') {
  const top = familyTop(fam);
  const places = [];
  for (let k = 0; k < TOP_N; k++) {
    const e = top[k]; const i = e && state.byId.get(e.id);
    const who = e && e.who.map((w) => `${w.person.id === state.me?.id ? 'You' : esc(w.person.name)} ${w.place}`).join(' · ');
    places.push(i ? `
        <li class="${goneClass(i).trim()}"><a href="#/item/${esc(i.id)}">
          <span class="ph-box">${topThumb(i)}<span class="badge">${k + 1}</span></span>
          <span class="txt"><span class="t">${esc(i.name)}</span><span class="who">${who}${famGot(i)}</span></span>
        </a></li>` : `
        <li class="none"><span class="ph-box"><span class="ph"></span><span class="badge">${k + 1}</span></span><span class="t">Not enough picks yet</span></li>`);
  }
  return `
    <div class="strip-wrap fam">
      <h3 class="strip-title">${esc(title)} <span class="s">from everyone's lists</span></h3>
      <ol class="strip">${places.join('')}</ol>
    </div>`;
}

function familyTopsHtml(fam) {
  if (!fam.members.some((m) => (state.top10[String(m.id)] || []).length)) return '';
  const shared = sharedPicks(fam.members);
  return `<div class="tops-compare" style="--cols:${fam.members.length + 1}">${familyStripHtml(fam)}${fam.members
    .map((m) => topStripHtml(m, state.top10[String(m.id)] || [], shared)).join('')}</div>`;
}

// Item page: add to / remove from your top 10.
function topLineHtml(item) {
  if (!canRank()) return '';
  const ids = myTop();
  const at = ids.indexOf(item.id);
  if (!rankingOpen()) return at >= 0 ? `<span class="badge-sq">${at + 1}</span> In your top 10` : '';
  if (at >= 0) return `<span class="badge-sq">${at + 1}</span> In your top 10 · <button type="button" class="link-btn" data-top-remove>Remove</button>`;
  if (myRank(item) == null) return '<span class="muted">Rank it to add it to your top 10.</span>';
  if (ids.length >= TOP_N) return '<span class="muted">Your top 10 is full.</span> <a href="#/family">Change it on My family</a>';
  return `<button type="button" class="btn ghost small" data-top-add>Add to my top 10</button>`;
}
function refreshTopLine() {
  const el = document.getElementById('top-line');
  if (!el) return;
  const item = state.byId.get(el.dataset.item);
  if (item) el.innerHTML = topLineHtml(item);
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('#top-line');
  if (!el) return;
  const id = el.dataset.item;
  const ids = myTop();
  if (e.target.closest('[data-top-add]') && ids.length < TOP_N && !ids.includes(id)) {
    ids.push(id);
    saveTop(ids, `Added to your top 10 as number ${ids.length}`);
  } else if (e.target.closest('[data-top-remove]')) {
    saveTop(ids.filter((x) => x !== id), 'Taken out of your top 10');
  }
});

// ------------------------------------------------------------------ assignment
//
// Ranking open -> ranking closed (the admin drafts who gets what) -> pushed to families.
// item.went_to is what families see (set by a push); item.assigned is the admin's
// working copy, which can run ahead of the last push until "Push update".

const stageNow = () => state.stage || { ranking_open: true, pushed_at: null };
const rankingOpen = () => stageNow().ranking_open !== false;
const isPushed = () => !!stageNow().pushed_at;
const famShort = (id) => `${familyName(id)}'s`;
const wentMine = (i) => i.went_to != null && i.went_to === state.me.family_id;

// Small "Your family" / "Sheri's" tag for tables and cards.
function wentTag(i) {
  if (!isPushed() || i.went_to == null) return '';
  return wentMine(i) ? '<span class="wtag mine">Your family</span>' : `<span class="wtag other">${esc(famShort(i.went_to))}</span>`;
}
// "✓ Yours" / "Went to Daniel's" on top 10 places.
function gotTag(i) {
  if (!isPushed() || i.went_to == null || !canRank()) return '';
  return wentMine(i) ? '<span class="wt yours">Yours</span>' : `<span class="wt other">Went to ${esc(famShort(i.went_to))}</span>`;
}
const goneClass = (i) => (isPushed() && canRank() && i.went_to != null && !wentMine(i) ? ' gone' : '');

// Notice at the top of Browse and My family for people who rank.
function stageNotice() {
  if (!canRank()) return '';
  if (isPushed()) {
    const n = state.items.filter(wentMine).length;
    return `
      <section class="out-banner" id="out-banner">
        <div><h2>Assignments are out.</h2><p>Your family received <b>${n} item${n === 1 ? '' : 's'}</b>. Every item now shows where it went.</p></div>
        <button type="button" class="btn ghost" data-received>See what your family received</button>
      </section>`;
  }
  if (!rankingOpen()) {
    return `
      <section class="closed-note">
        <h2>Ranking is closed</h2>
        <p>The admin is working out who gets what. Your ranks and top 10 are kept as they are. Once assignments go out, every item will show which family it went to.</p>
      </section>`;
  }
  return '';
}
document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-received]')) return;
  const v = loadView('fi_family', {});
  setStored('fi_family', JSON.stringify({ ...v, who: 'all', went: 'mine' }), 'sessionStorage');
  if (currentRoute().name === 'family') {
    renderFamily();
    document.getElementById('tbl')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else {
    location.hash = '#/family';
  }
});

// Item page: where it went (everyone), plus the admin's unpushed draft.
function wentLineHtml(item) {
  const parts = [];
  if (isPushed() && item.went_to != null) {
    parts.push(wentMine(item)
      ? '<span class="wtag mine">Your family</span> This went to your family.'
      : `Went to <b>${esc(familyName(item.went_to))}'s family</b>`);
  }
  if (state.me.is_admin && item.assigned != null && item.assigned !== item.went_to) {
    parts.push(`<span class="draft-tag">Draft: ${esc(famShort(item.assigned))}, not pushed yet</span>`);
  }
  if (state.me.is_admin && item.assigned == null && !rankingOpen() && !item.hidden) parts.push('<span class="draft-tag">No family yet</span>');
  return parts.length ? `<p class="went-line">${parts.join(' ')}</p>` : '';
}

// ---- admin: the Assign screen

const ASSIGN_VIEW = 'fi_assign';

// The family (or tied families) with the best rank for an item.
function suggestion(i) {
  const fb = i.family_best || {};
  const vals = Object.values(fb);
  if (!vals.length) return { best: null, fams: [] };
  const best = Math.min(...vals);
  return { best, fams: state.families.filter((f) => fb[String(f.id)] === best).map((f) => f.id) };
}
const suggested = (i) => { const s = suggestion(i); return s.fams.length === 1 ? s.fams[0] : null; };
const isTie = (i) => suggestion(i).fams.length > 1;
const changedSincePush = (i) => isPushed() && i.assigned !== (i.went_to ?? null);

// family id -> Map(item id -> { place, who }) over each family's full combined list.
function familyPlaces() {
  const out = new Map();
  for (const f of state.families) {
    const m = new Map();
    familyTop(f, Infinity).forEach((e, k) => m.set(e.id, { place: k + 1, who: e.who }));
    out.set(f.id, m);
  }
  return out;
}

function whyHtml(i, places) {
  const s = suggestion(i);
  const lines = [];
  if (changedSincePush(i)) lines.push(`<span class="chg">${i.went_to == null ? 'New' : `Changed · was ${esc(famShort(i.went_to))}`}</span>`);
  if (!s.fams.length) lines.push('<span class="none">No one has given a preference</span>');
  else if (s.fams.length === 1) {
    lines.push(`<span>Best: <b>${esc(famShort(s.fams[0]))}</b> (${s.best})${i.assigned != null && i.assigned !== s.fams[0] ? ` · you chose ${esc(famShort(i.assigned))}` : ''}</span>`);
  } else {
    const names = s.fams.map(famShort);
    const list = names.length === 2 ? names.join(' & ') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
    lines.push(`<span class="tie"><b>${i.assigned != null ? 'Was a tie' : 'Tie'}:</b> ${esc(list)} (${names.length === 2 ? 'both' : 'all'} ${s.best})</span>`);
  }
  const t10 = [];
  const others = [];
  for (const f of state.families) {
    const p = places.get(f.id)?.get(i.id);
    if (!p) continue;
    const who = p.who.map((w) => `${esc(w.person.name)} ${w.place}`).join(', ');
    if (p.place <= TOP_N) t10.push(`${esc(famShort(f.id))} #${p.place} <span class="whois">(${who})</span>`);
    else others.push(`${esc(famShort(f.id))}: ${who}`);
  }
  if (t10.length) lines.push(`<span class="t10">Family top 10: ${t10.join(' · ')}</span>`);
  if (others.length) lines.push(`<span>On personal lists: ${others.join(' · ')}</span>`);
  if (!t10.length && !others.length && s.fams.length) lines.push('<span>Not in anyone\'s top 10</span>');
  return lines.join('');
}

function famButtons(i) {
  const s = suggestion(i);
  const locked = rankingOpen();
  return `<span class="pick">${state.families.map((f) => {
    let cls = 'fb';
    if (i.assigned === f.id) cls += ' on';
    else if (i.assigned == null && s.fams.length === 1 && s.fams[0] === f.id) cls += ' sugg';
    else if (i.assigned == null && s.fams.length > 1 && s.fams.includes(f.id)) cls += ' tied';
    return `<button type="button" class="${cls}" data-assign="${f.id}" aria-pressed="${i.assigned === f.id}" ${locked ? 'disabled' : ''}
      aria-label="${esc(i.name)} goes to ${esc(famShort(f.id))} family">${esc(famShort(f.id))}</button>`;
  }).join('')}</span>`;
}

function statusHtml(i, phone) {
  if (rankingOpen()) return '<span class="st">Close ranking to assign</span>';
  if (i.assigned != null) return changedSincePush(i) ? '<span class="st draft">Not pushed</span>' : '<span class="st">Confirmed</span>';
  const sg = suggested(i);
  if (sg != null) return `<button type="button" class="btn ${phone ? '' : 'ghost '}small" data-confirm="${sg}">Confirm${phone ? ` ${esc(famShort(sg))}` : ''}</button>`;
  return '<span class="st ask">Pick a family</span>';
}

function assignRowHtml(i, places, phone) {
  const changed = changedSincePush(i) ? ' changed' : '';
  if (phone) {
    return `
      <div class="acard${changed}" data-row="${esc(i.id)}">
        <a class="top" href="#/item/${esc(i.id)}">${photoOf(i)?.thumb ? `<img src="${esc(photoOf(i).thumb)}" alt="" loading="lazy" />` : '<span class="ph"></span>'}
          <span><span class="t">${esc(i.name)}</span><br><span class="s">${esc(i.room)} · ${esc(i.id)}</span></span></a>
        <div class="ranks">${state.families.map((f) => `<div><span class="f">${esc(f.name)}</span>${rankCell(i.family_best[String(f.id)]) || '<span class="dash">–</span>'}</div>`).join('')}</div>
        <div class="why">${whyHtml(i, places)}</div>
        ${famButtons(i)}
        <div class="foot">${statusHtml(i, true)}</div>
      </div>`;
  }
  return `
    <tr class="${changed.trim()}" data-row="${esc(i.id)}">
      <td class="item-cell">${miniItem(i)}</td>
      ${state.families.map((f) => `<td class="num">${rankCell(i.family_best[String(f.id)]) || '<span class="dash">–</span>'}</td>`).join('')}
      <td class="why">${whyHtml(i, places)}</td>
      <td class="goes">${famButtons(i)}<span class="act">${statusHtml(i, false)}</span></td>
    </tr>`;
}

const ASSIGN_CHIPS = [
  ['all', 'All', () => true],
  ['needs', 'Needs a decision', (i) => i.assigned == null],
  ['ties', 'Ties', (i) => isTie(i)],
  ['multi', 'Wanted by 2+ families', (i) => Object.keys(i.family_best).length > 1],
  ['top', 'In someone\'s top 10', (i, places) => state.families.some((f) => places.get(f.id)?.has(i.id))],
  ['none', 'Nobody ranked', (i) => !Object.keys(i.family_best).length],
  ['done', 'Confirmed', (i) => i.assigned != null],
  ['changed', 'Changed since push', (i) => changedSincePush(i)],
];

function flowHtml(pool) {
  const st = stageNow();
  const total = pool.length;
  const done = pool.filter((i) => i.assigned != null).length;
  const left = total - done;
  const changes = pool.filter(changedSincePush).length;
  const open = rankingOpen();
  const steps = [
    ['Ranking open', open ? 'Families are ranking' : ''],
    ['Ranking closed', st.closed_at ? `Closed ${fmtDate(st.closed_at)}` : 'Not yet'],
    ['Draft assignments', `${done} of ${total} confirmed`],
    ['Pushed to families', st.pushed_at ? `Pushed ${fmtDate(st.pushed_at)}` : 'Families see nothing yet'],
  ];
  const cur = open ? 0 : isPushed() ? 4 : 2;
  const stepHtml = steps.map(([l, d], k) => {
    const state_ = k < cur || (isPushed() && k === 3) ? 'done' : k === cur ? 'now cur' : '';
    return `<li class="step ${state_}"><span class="k">${state_ === 'done' ? '✓' : k + 1}</span><span class="l">${l}${d ? `<span class="d">${esc(d)}</span>` : ''}</span></li>`;
  }).join('');
  let bar;
  if (open) {
    bar = `<div class="flow-bar"><p class="fb-text"><b>Ranking is open.</b> Families can still change their ranks and top 10s, so the suggestions below can change. Close ranking to start assigning.</p>
      <div class="fb-act"><button type="button" class="btn" id="close-ranking">Close ranking</button></div></div>`;
  } else if (!isPushed()) {
    bar = `<div class="flow-bar"><p class="fb-text"><b>Draft.</b> Families see nothing until you push. ${left
      ? `<b>${left} item${left === 1 ? '' : 's'}</b> still need${left === 1 ? 's' : ''} a family. Push unlocks when every item has one.`
      : 'Every item has a family.'}</p>
      <div class="fb-act"><button type="button" class="link-btn" id="reopen-ranking">Reopen ranking</button>
        <button type="button" class="btn" id="push" ${left ? 'disabled' : ''}>${left ? `Push locked · ${left} left` : 'Push to families'}</button></div></div>`;
  } else if (changes) {
    bar = `<div class="flow-bar has-changes"><p class="fb-text"><span class="pending"><b>${changes} change${changes === 1 ? '' : 's'} not yet pushed.</b></span> Families still see the version from ${esc(fmtDate(st.pushed_at))}.${left ? ` <b>${left} item${left === 1 ? '' : 's'}</b> need${left === 1 ? 's' : ''} a family before you can push.` : ''}</p>
      <div class="fb-act"><button type="button" class="link-btn" id="show-changes">Show changes</button>
        <button type="button" class="link-btn" id="discard">Discard</button>
        <button type="button" class="btn" id="push" ${left ? 'disabled' : ''}>${left ? `Push locked · ${left} left` : 'Push update'}</button></div></div>`;
  } else {
    bar = `<div class="flow-bar"><p class="fb-text"><b>Pushed ${esc(fmtDate(st.pushed_at))}.</b> Families see where every item went. Anything you change here stays a draft until you push an update.</p></div>`;
  }
  return `<ol class="steps">${stepHtml}</ol>${bar}`;
}

function tallyHtml(pool) {
  const un = pool.filter((i) => i.assigned == null).length;
  return `<span class="c lead">Confirmed so far</span>${state.families.map((f) => `
    <span class="c"><span class="fam">${esc(famShort(f.id))}</span><span class="n">${pool.filter((i) => i.assigned === f.id).length}</span></span>`).join('')}
    <span class="c un"><span class="fam">Unassigned</span><span class="n">${un}</span></span>`;
}

function renderAssign() {
  if (!state.me.is_admin) { location.hash = '#/'; return; }
  const f = loadView(ASSIGN_VIEW, { q: '', fam: '', room: '', sort: 'best', chip: 'all' });
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  shell('assign', `
    <h1 class="page-title">Assign</h1>
    <p class="page-sub">Give each item to one family. Each item starts with the family that ranked it best: confirm it, or tap another family.</p>
    <section class="flow" id="flow"></section>
    <div class="tally" id="tally"></div>
    <div class="atools">
      <input class="input search" type="search" placeholder="Search by name, room or ID" value="${esc(f.q)}" data-f="q" aria-label="Search" />
      <div class="row">
        <select class="select" data-f="fam" aria-label="Family">${opt('', 'Any family', f.fam)}${state.families.map((fm) => opt(`a${fm.id}`, `Going to ${famShort(fm.id)}`, f.fam)).join('')}${state.families.map((fm) => opt(`s${fm.id}`, `Best rank: ${famShort(fm.id)}`, f.fam)).join('')}</select>
        <select class="select" data-f="room" aria-label="Room">${opt('', 'All rooms', f.room)}${rooms().map((r) => opt(r, r, f.room)).join('')}</select>
        <select class="select" data-f="sort" aria-label="Sort">${opt('best', 'Sort: best rank', f.sort)}${opt('catalog', 'Sort: catalog order', f.sort)}${opt('room', 'Sort: room', f.sort)}${opt('name', 'Sort: name A to Z', f.sort)}</select>
      </div>
    </div>
    <div class="vchips" id="chips" role="group" aria-label="Show"></div>
    <p class="count" id="count"></p>
    <div class="legend"><span><span class="fb sugg">Sheri's</span>Suggested: best family rank</span><span><span class="fb on">Sheri's</span>Confirmed</span><span><span class="fb tied">Sheri's</span>Tied for best</span></div>
    <div id="assign-list"></div>`);

  const pool = () => state.items.filter((i) => !i.hidden);
  const phoneMq = window.matchMedia('(max-width: 699px)');
  let places = familyPlaces();

  const drawTop = () => {
    const p = pool();
    document.getElementById('flow').innerHTML = flowHtml(p);
    document.getElementById('tally').innerHTML = tallyHtml(p);
    document.getElementById('chips').innerHTML = ASSIGN_CHIPS
      .filter(([k]) => k !== 'changed' || isPushed())
      .map(([k, label, test]) => `<button type="button" class="chip" data-chip="${k}" aria-pressed="${f.chip === k}">${label} <i>${p.filter((i) => test(i, places)).length}</i></button>`).join('');
  };
  const rowsNow = () => {
    const q = f.q.trim().toLowerCase();
    const test = (ASSIGN_CHIPS.find(([k]) => k === f.chip) || ASSIGN_CHIPS[0])[2];
    let rows = pool().filter((i) => {
      if (f.room && i.room !== f.room) return false;
      if (!matchesQuery(i, q)) return false;
      if (f.fam && f.fam[0] === 'a' && i.assigned !== Number(f.fam.slice(1))) return false;
      if (f.fam && f.fam[0] === 's' && !suggestion(i).fams.includes(Number(f.fam.slice(1)))) return false;
      return test(i, places);
    });
    if (f.sort === 'best') rows = [...rows].sort((a, b) => (suggestion(a).best ?? 9) - (suggestion(b).best ?? 9));
    else rows = [...rows].sort(SORTS[f.sort] || SORTS.catalog);
    return rows;
  };
  const draw = () => {
    if (!document.getElementById('assign-list')) return;
    places = familyPlaces();
    drawTop();
    const rows = rowsNow();
    const phone = phoneMq.matches;
    document.getElementById('count').textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}`;
    const body = rows.map((i) => assignRowHtml(i, places, phone)).join('');
    document.getElementById('assign-list').innerHTML = phone
      ? `<div class="acards">${body || '<p class="empty-state">Nothing matches. Try another filter.</p>'}</div>`
      : `<div class="table-wrap"><table class="data assign"><colgroup><col class="c-item">${state.families.map(() => '<col class="c-r">').join('')}<col class="c-why"><col class="c-goes"></colgroup>
          <thead><tr><th>Item</th>${state.families.map((fm) => `<th class="num">${esc(famShort(fm.id))}</th>`).join('')}<th>Why</th><th class="goes">Goes to</th></tr></thead>
          <tbody>${body || `<tr><td colspan="${state.families.length + 3}" class="empty-state">Nothing matches. Try another filter.</td></tr>`}</tbody></table></div>`;
  };
  draw();
  wireToolbar(f, ASSIGN_VIEW, draw);
  phoneMq.addEventListener?.('change', () => { if (currentRoute().name === 'assign') draw(); });

  const redrawRow = (i) => {
    const el = document.querySelector(`[data-row="${CSS.escape(i.id)}"]`);
    if (el) el.outerHTML = assignRowHtml(i, places, phoneMq.matches);
    drawTop();
  };
  const setFamily = async (i, fam) => {
    const before = i.assigned;
    i.assigned = fam;
    redrawRow(i);
    savesInFlight++;
    try {
      await state.api.adminAssign(i.id, fam);
      toast(fam == null ? `${i.name}: back to unassigned` : `${i.name} goes to ${famShort(fam)} family`);
    } catch (err) {
      if (!state.me) return;
      i.assigned = before;
      redrawRow(i);
      toast(err.message, true);
    } finally {
      savesInFlight--;
    }
  };
  const setStage = (st) => { state.stage = st; draw(); };

  app.querySelector('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    f.chip = b.dataset.chip;
    setStored(ASSIGN_VIEW, JSON.stringify(f), 'sessionStorage');
    draw();
  });
  app.querySelector('#assign-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-row]');
    const i = row && state.byId.get(row.dataset.row);
    if (!i) return;
    const a = e.target.closest('[data-assign]');
    if (a && !a.disabled) {
      const fam = Number(a.dataset.assign);
      setFamily(i, i.assigned === fam ? null : fam); // tapping the chosen family again takes it back
      return;
    }
    const c = e.target.closest('[data-confirm]');
    if (c) setFamily(i, Number(c.dataset.confirm));
  });
  app.querySelector('#flow').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    try {
      if (b.id === 'close-ranking') {
        if (!confirmInline(b, 'Tap again to close ranking. Families will no longer be able to change ranks or top 10s.')) return;
        setStage(await state.api.adminSetRanking(false));
        toast('Ranking is closed');
      } else if (b.id === 'reopen-ranking') {
        if (!confirmInline(b, 'Tap again to reopen ranking. Your draft assignments are kept.')) return;
        setStage(await state.api.adminSetRanking(true));
        toast('Ranking is open again');
      } else if (b.id === 'push') {
        if (!confirmInline(b, isPushed() ? 'Tap again to send these changes to every family.' : 'Tap again to send assignments to every family. Ranking cannot reopen after this.')) return;
        b.disabled = true;
        const st = await state.api.adminPush();
        for (const i of state.items) i.went_to = i.hidden ? i.went_to : i.assigned;
        setStage(st);
        toast('Assignments sent to families');
      } else if (b.id === 'discard') {
        if (!confirmInline(b, 'Tap again to undo every change since the last push.')) return;
        await state.api.adminDiscardAssignments();
        for (const i of state.items) if (!i.hidden) i.assigned = i.went_to ?? null;
        draw();
        toast('Changes discarded');
      } else if (b.id === 'show-changes') {
        f.chip = 'changed';
        setStored(ASSIGN_VIEW, JSON.stringify(f), 'sessionStorage');
        draw();
      }
    } catch (err) {
      if (!state.me) return;
      toast(err.message, true);
      draw();
    }
  });
}

// ------------------------------------------------------------------ results

function renderResults() {
  if (!state.me.is_admin) { location.hash = '#/'; return; } // Results is for the admin only
  const f = loadView('fi_results', { q: '', room: '', type: '', view: 'ranked', fam: '', sort: 'best' });
  shell('results', `
    <h1 class="page-title">Results</h1>
    <p class="page-sub">For each item: the best (lowest) family rank, which family wants it most, and each family's rank. Ties are listed together. “Set” marks a family rank a sibling adjusted by hand.</p>
    ${(() => {
      const fams = state.families.map((fm) => ({ fm, html: familyTopsHtml(fm) })).filter((x) => x.html);
      return fams.length ? `<section class="family-tops admin-tops"><div class="top10-head"><h2 class="section-title">Family top 10s</h2><p class="top10-note">Each family's list adds up its members' lists: 1st place is worth 10 points, 10th is worth 1.</p></div>
        <div class="tops-compare" style="--cols:${fams.length}">${fams.map((x) => familyStripHtml(x.fm, `${x.fm.name}'s family`)).join('')}</div>
        <h3 class="strip-title each-title">Each person's list</h3>${fams.map((x) => `<details class="fam-tops"><summary>${esc(x.fm.name)}'s family</summary>${x.html}</details>`).join('')}</section>` : '';
    })()}
    ${tableToolbar(f, (opt) => `
      <select class="select" data-f="view" aria-label="Show">${opt('ranked', 'Items anyone ranked', f.view)}${opt('multi', 'Wanted by 2 or more families', f.view)}${opt('tied', 'Tied between families', f.view)}${opt('none', 'Nobody has ranked yet', f.view)}${opt('all', 'All items', f.view)}</select>
      <select class="select" data-f="fam" aria-label="Family">${opt('', 'Any family', f.fam)}${state.families.map((fm) => opt(String(fm.id), `Most wanted by ${fm.name}'s family`, f.fam)).join('')}</select>
      <select class="select" data-f="sort" aria-label="Sort">${opt('best', 'Sort: best rank', f.sort)}${opt('families', 'Sort: most families interested', f.sort)}${opt('catalog', 'Sort: catalog order', f.sort)}${opt('room', 'Sort: room', f.sort)}${opt('name', 'Sort: name A to Z', f.sort)}</select>`)}
    ${state.me.is_admin ? '<p class="csv-row"><button type="button" class="chip" id="csv">Download everything as a spreadsheet (CSV)</button></p>' : ''}
    <p class="count" id="count"></p>
    <div class="table-wrap"><table class="data" id="tbl"></table></div>`);

  const draw = () => {
    if (!document.getElementById('tbl')) return;
    const q = f.q.trim().toLowerCase();
    const nFam = (i) => Object.keys(i.family_best).length;
    let rows = state.items.filter((i) => {
      if (f.room && i.room !== f.room) return false;
      if (f.type && i.type !== f.type) return false;
      if (!matchesQuery(i, q)) return false;
      if (f.fam && !i.top_families.includes(Number(f.fam))) return false;
      if (f.view === 'ranked') return i.overall_best != null;
      if (f.view === 'multi') return nFam(i) >= 2;
      if (f.view === 'tied') return i.top_families.length >= 2;
      if (f.view === 'none') return i.overall_best == null;
      return true;
    });
    if (f.sort === 'best') rows = [...rows].sort((a, b) => (a.overall_best ?? 9) - (b.overall_best ?? 9));
    else if (f.sort === 'families') rows = [...rows].sort((a, b) => nFam(b) - nFam(a) || (a.overall_best ?? 9) - (b.overall_best ?? 9));
    else rows = [...rows].sort(SORTS[f.sort] || SORTS.catalog);
    document.getElementById('count').textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}`;
    document.getElementById('tbl').innerHTML = `
      <thead><tr><th>Item</th><th class="num key">Best</th><th class="key">Most wanted by</th>${state.families.map((fm) => `<th class="num">${esc(fm.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((i) => `<tr><td class="item-cell">${miniItem(i)}</td><td class="num key">${rankCell(i.overall_best)}</td><td class="key who">${esc(i.top_families.map(familyName).join(', '))}</td>${state.families.map((fm) => { const set = famSet(i, fm.id); return `<td class="num fr"${set ? ` title="Set by ${esc(set.by)}${set.auto != null ? `; automatic ${set.auto}` : ''}"` : ''}>${rankCell(i.family_best[String(fm.id)])}${set ? '<span class="fr-set">set</span>' : ''}</td>`; }).join('')}</tr>`).join('')
        || `<tr><td colspan="${state.families.length + 3}" class="empty-state">Nothing matches. Try another filter.</td></tr>`}</tbody>`;
  };
  draw();
  wireToolbar(f, 'fi_results', draw);
  document.getElementById('csv')?.addEventListener('click', downloadCsv);
}

function downloadCsv() {
  const people = state.families.flatMap((f) => f.members.map((m) => ({ ...m, fam: f })));
  const head = ['Item ID', 'Name', 'Room', 'Photo #', 'Type', 'Subtype', 'Origin', 'Description',
    ...people.map((p) => `${p.fam.name}: ${p.name}`), ...state.families.map((f) => `${f.name} family rank`), ...state.families.map((f) => `${f.name} set by`), 'Overall best', 'Top interest', 'Assigned (draft)', 'Went to (pushed)'];
  const cell = (v) => {
    let s = String(v ?? '');
    // Keep spreadsheet apps from running a value as a formula.
    if (/^[=+\-@\t\r]/.test(s) || /[\r\n]\s*[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.map(cell).join(',')];
  for (const i of state.items) {
    lines.push([i.id, i.name, i.room, i.photo_no, i.type, i.subtype, i.origin, i.description,
      ...people.map((p) => i.ranks[String(p.id)] ?? ''), ...state.families.map((f) => i.family_best[String(f.id)] ?? ''),
      ...state.families.map((f) => famSet(i, f.id)?.by ?? ''),
      i.overall_best ?? '', i.top_families.map(familyName).join(' & '),
      i.assigned != null ? familyName(i.assigned) : '', i.went_to != null ? familyName(i.went_to) : ''].map(cell).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `family-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ admin

async function renderAdmin() {
  if (!state.me.is_admin) { location.hash = '#/'; return; }
  shell('admin', `
    <h1 class="page-title">Admin</h1>
    <p class="page-sub">Make a personal link for each person and send it by text or email. Making a new link turns off that person's old one. The four siblings can edit item details (Edit info in Browse) and adjust their family's ranks. Children rank and keep a top 10.</p>
    <div class="admin-sections">
      <section>
        <div class="eyebrow" style="margin-bottom:8px">People</div>
        <p class="people-summary" id="people-summary"></p>
        <div class="people" id="people"><p class="loading">Loading…</p></div>
      </section>
      <section>
        <div class="eyebrow" style="margin-bottom:8px">Items</div>
        <p style="font-size:14px;color:var(--muted)">${state.items.length} items on the website. Open any item to edit it or remove it. Download everything from <a href="#/results">Results</a>.</p>
        <div class="eyebrow" style="margin:20px 0 8px">Removed items</div>
        <p style="font-size:14px;color:var(--muted)">Removed items are off the website for everyone, you included, but stay in the database with their ranks and history. Restore puts one back.</p>
        <ul class="removed" id="removed"><li class="loading">Loading…</li></ul>
      </section>
    </div>`);

  const box = document.getElementById('people');
  let people;
  const draw = () => {
    // Keep any "new link" panels open: each key is shown only once.
    const panels = [...box.querySelectorAll('.new-link')].map((el) => [el.closest('.person')?.dataset.id, el]);
    box.innerHTML = people.map((p) => `
      <div class="person" data-id="${p.id}">
        <div>
          <div class="n">${esc(p.name)}</div>
          <div class="d">${esc(p.family ? `${p.family}'s family · ${p.role}` : 'site admin')}${p.is_admin && p.role !== 'admin' ? ' · admin' : ''} ·
            ${p.has_link ? (p.last_seen_at ? `last opened ${esc(fmtDate(p.last_seen_at))}` : 'link not opened yet') : 'no link yet'}
            · ${p.ranked} ranked</div>
        </div>
        <div class="actions">
          <button type="button" class="btn small ${p.has_link ? 'ghost' : ''}" data-new="${p.id}">${p.has_link ? 'New link' : 'Make link'}</button>
          ${p.has_link && p.id !== state.me.id ? `<button type="button" class="btn ghost small" data-off="${p.id}">Turn off</button>` : ''}
        </div>
      </div>`).join('');
    for (const [id, el] of panels) box.querySelector(`.person[data-id="${id}"]`)?.append(el);
    const rankers = people.filter((p) => p.family_id != null);
    const opened = rankers.filter((p) => p.last_seen_at).length;
    const started = rankers.filter((p) => p.ranked > 0).length;
    const total = rankers.reduce((n, p) => n + p.ranked, 0);
    document.getElementById('people-summary').textContent =
      `${rankers.filter((p) => p.has_link).length} of ${rankers.length} family members have a link, ${opened} have opened it, `
      + `and ${started} have started ranking (${total} ranks in all).`;
  };
  drawRemoved();
  try {
    people = await state.api.adminPeople();
    draw();
  } catch (err) {
    box.innerHTML = `<p class="empty-state">${esc(err.message)}</p>`;
    return;
  }

  box.addEventListener('click', async (e) => {
    const nb = e.target.closest('[data-new]');
    const ob = e.target.closest('[data-off]');
    if (nb) {
      const p = people.find((x) => x.id === Number(nb.dataset.new));
      if (p.has_link && !confirmInline(nb, `This turns off ${p.name}'s current link. Tap again to continue.`)) return;
      nb.disabled = true;
      try {
        const key = await state.api.adminNewLink(p.id);
        p.has_link = true;
        p.last_seen_at = null;
        if (p.id === state.me.id) { state.api = makeApi(key, onInvalidLink); rememberKey(key, state.me.name); }
        draw();
        showNewLink(p, key);
      } catch (err) { if (state.me) toast(err.message, true); nb.disabled = false; }
    }
    if (ob) {
      const p = people.find((x) => x.id === Number(ob.dataset.off));
      if (!confirmInline(ob, `Turn off ${p.name}'s link? Tap again to confirm.`)) return;
      try {
        await state.api.adminTurnOffLink(p.id);
        p.has_link = false;
        box.querySelector(`.person[data-id="${p.id}"] .new-link`)?.remove();
        draw();
        toast(`${p.name}'s link is off`);
      } catch (err) { toast(err.message, true); }
    }
  });

  function showNewLink(p, key) {
    const link = personalLink(key);
    const row = box.querySelector(`.person[data-id="${p.id}"]`);
    // The link goes alone on the last line: some phones cut the end off a link
    // that has text right after it.
    const msg = `Hi ${p.name}, this is your own link to the family inventory. Please don't forward it.\n\n`
      + 'Tap it any time to open the site signed in as you, on your phone, tablet or computer. '
      + 'Keep this message so you can tap it again later. If the site ever shows "Welcome", just tap this link again.\n\n'
      + link;
    const enc = encodeURIComponent(msg);
    const sms = /iPhone|iPad|Macintosh/.test(navigator.userAgent) ? `sms:&body=${enc}` : `sms:?body=${enc}`;
    const div = document.createElement('div');
    div.className = 'new-link';
    div.innerHTML = `
      <strong>${esc(p.name)}'s new link</strong> (shown once, so send it now)
      <code>${esc(link)}</code>
      <div class="actions">
        <button type="button" class="btn small" data-copy>Copy link</button>
        ${navigator.share ? '<button type="button" class="btn ghost small" data-share>Share…</button>' : ''}
        <a class="btn ghost small" style="display:inline-flex;align-items:center;text-decoration:none" href="${sms}">Text</a>
        <a class="btn ghost small" style="display:inline-flex;align-items:center;text-decoration:none" href="mailto:?subject=${encodeURIComponent('Your family inventory link')}&body=${enc}">Email</a>
      </div>`;
    row.append(div);
    div.querySelector('[data-copy]').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(link); toast('Link copied'); }
      catch { toast('Select the link above and copy it', true); }
    });
    div.querySelector('[data-share]')?.addEventListener('click', () => navigator.share({ title: 'Family inventory', text: msg }).catch(() => {}));
  }
}

// The Admin page's list of removed items, each with Restore.
async function drawRemoved() {
  const ul = document.getElementById('removed');
  if (!ul) return;
  let list;
  try { list = await state.api.adminRemovedItems(); }
  catch (err) { ul.innerHTML = `<li>${esc(err.message)}</li>`; return; }
  if (!document.body.contains(ul)) return;
  ul.innerHTML = list.length ? list.map((r) => `
    <li>
      ${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy" />` : '<span class="ph"></span>'}
      <span class="t"><b>${esc(r.name)}</b><br><span class="s">${esc(r.id)} · ${esc(r.room)}${r.at ? ` · removed ${esc(fmtDate(r.at))}${r.by ? ` by ${esc(r.by)}` : ''}` : ''}</span></span>
      <button type="button" class="btn ghost small" data-unremove="${esc(r.id)}">Restore</button>
    </li>`).join('') : '<li class="none">Nothing has been removed.</li>';
  ul.onclick = async (e) => {
    const b = e.target.closest('[data-unremove]');
    if (!b || !confirmInline(b, `Tap again to put ${b.dataset.unremove} back on the website.`)) return;
    b.disabled = true;
    try {
      await state.api.adminSetHidden(b.dataset.unremove, false);
      ingest(await state.api.load());
      toast(`${b.dataset.unremove} is back on the website`);
      renderAdmin();
    } catch (err) { if (state.me) toast(err.message, true); b.disabled = false; }
  };
}

function confirmInline(btn, message) {
  if (btn.dataset.armed === '1') return true;
  btn.dataset.armed = '1';
  const label = btn.textContent;
  btn.textContent = 'Tap to confirm';
  toast(message);
  setTimeout(() => { btn.dataset.armed = ''; btn.textContent = label; }, 4000);
  return false;
}

// ------------------------------------------------------------------ router

function currentRoute() {
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/^\/item\/(ITEM-\d{4})$/);
  if (m) return { name: 'item', id: m[1] };
  if (h === '/family') return { name: 'family' };
  if (h === '/results') return { name: 'results' };
  if (h === '/assign') return { name: 'assign' };
  if (h === '/admin') return { name: 'admin' };
  return { name: 'browse' };
}

let lastRoute = null;
function route() {
  if (!state.me) return;
  const r = currentRoute();
  if (r.name === 'item') renderItem(r.id);
  else if (r.name === 'family') renderFamily();
  else if (r.name === 'results') renderResults();
  else if (r.name === 'assign') renderAssign();
  else if (r.name === 'admin') renderAdmin();
  else renderBrowse();
  // Coming back from an item puts the list where it was; anything else starts at the top.
  if (r.name !== 'item') {
    const y = lastRoute === 'item' ? Number(getStored(`fi_scroll_${r.name}`, 'sessionStorage') || 0) : 0;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }
  lastRoute = r.name;
}

window.addEventListener('hashchange', () => {
  const k = keyFromUrl();
  if (k && k !== memoryKey) { start(); return; } // a different link was opened in this tab
  route();
});

// Pick up other people's new ranks when the page comes back into view,
// without losing the person's place on the page.
async function refresh(force = false) {
  if (!state.api || savesInFlight) return;
  if (!force && Date.now() - state.loadedAt < 120000) return;
  if (document.querySelector('.edit-modal, .new-link, .lightbox, .fr-row')) return;
  try {
    const data = await state.api.load();
    if (!state.me || savesInFlight || document.querySelector('.edit-modal, .new-link, .lightbox, .fr-row')) return;
    const y = window.scrollY;
    const historyOpen = document.getElementById('history')?.hidden === false;
    ingest(data);
    route();
    window.scrollTo(0, y);
    if (historyOpen) document.getElementById('show-history')?.click();
  } catch { /* keep what we have; a turned-off link is handled by onInvalidLink */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
// Coming back with the Back button can show a frozen copy of the page; check the link is still good.
window.addEventListener('pageshow', (e) => { if (e.persisted) refresh(true); });

function showLoadError(err) {
  app.innerHTML = `<div class="center-box"><h1>Sorry</h1><p>${esc(err.message)}</p><p><button type="button" class="btn" id="retry">Try again</button></p></div>`;
  document.getElementById('retry').addEventListener('click', () => start());
}

// Ask before a different person's link takes over a device someone else uses.
function confirmSwitch(currentName, newName) {
  return new Promise((resolve) => {
    app.innerHTML = `
      <div class="center-box">
        <p class="eyebrow">Family Inventory</p>
        <h1>Who is ranking?</h1>
        <p>This device is signed in as <b>${esc(currentName)}</b>. The link you opened is <b>${esc(newName)}</b>'s.</p>
        <div class="choices">
          <button type="button" class="btn" data-pick="new">Continue as ${esc(newName)}</button>
          <button type="button" class="btn ghost" data-pick="old">Stay as ${esc(currentName)}</button>
        </div>
      </div>`;
    app.querySelector('.choices').addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]');
      if (b) resolve(b.dataset.pick === 'new');
    });
  });
}

async function start() {
  const fromUrl = keyFromUrl();
  const saved = savedKey();
  const savedName = getStored(NAME_STORE);
  const tries = [...new Set([fromUrl, memoryKey, saved].filter(Boolean))];
  if (!tries.length) {
    showSignedOut(brokenKeyInUrl()
      ? 'This link looks cut off. Please tap the whole link in the newest message from Paul, or ask him to send it again.'
      : undefined);
    return;
  }
  app.innerHTML = '<p class="loading">Loading the collection…</p>';
  for (const key of tries) {
    let data;
    try {
      data = await makeApi(key).load();
    } catch (err) {
      if (err.invalidLink) continue; // try the next key we know about
      showLoadError(err);
      return;
    }
    const otherPerson = savedName && savedName !== data.me.name && saved && saved !== key;
    if (otherPerson) {
      let savedStillWorks = false;
      try { await makeApi(saved).load(); savedStillWorks = true; } catch { /* old person's link is gone */ }
      if (savedStillWorks && !(await confirmSwitch(savedName, data.me.name))) {
        history.replaceState(null, '', `${BASE}?k=${saved}#/`);
        memoryKey = null;
        start();
        return;
      }
      VIEW_STORES.forEach((k) => setStored(k, null, 'sessionStorage')); // don't inherit their filters
    }
    state.api = makeApi(key, onInvalidLink);
    ingest(data);
    rememberKey(key, data.me.name);
    route();
    if (fromUrl && key !== fromUrl) toast('That link is out of date, so you are still signed in with your newer one.');
    else if (otherPerson) toast(`You are now signed in as ${data.me.name}.`);
    return;
  }
  forgetKey();
  showSignedOut(fromUrl
    ? 'This link did not work. It may be cut off or out of date. Please tap the link in the newest message from Paul, or ask him for a new one.'
    : 'Your link has been replaced. Please tap the newest link Paul sent you.');
}

start();
