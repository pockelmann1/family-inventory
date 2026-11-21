// Fonts are served with the site (no Google Fonts request before the page shows).
import '@fontsource/cormorant-garamond/latin-400.css';
import '@fontsource/cormorant-garamond/latin-400-italic.css';
import '@fontsource/cormorant-garamond/latin-500.css';
import '@fontsource/jost/latin-300.css';
import '@fontsource/jost/latin-400.css';
import '@fontsource/jost/latin-500.css';
import './style.css';
import { makeApi } from './api.js';

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
  loadedAt: 0,
};

function ingest(data) {
  state.me = data.me;
  state.families = data.families;
  state.items = data.items;
  state.byId = new Map(data.items.map((i) => [i.id, i]));
  state.people = new Map();
  for (const f of data.families) for (const m of f.members) state.people.set(String(m.id), { ...m, family_id: f.id });
  state.loadedAt = Date.now();
}

const familyName = (id) => state.families.find((f) => f.id === Number(id))?.name ?? '';
const myRank = (item) => item.ranks[String(state.me.id)] ?? null;
const canRank = () => state.me.family_id != null;
const photoOf = (item) => item.photos[0] || null;
const rooms = () => [...new Set(state.items.map((i) => i.room).filter(Boolean))].sort();
const types = () => [...new Set(state.items.map((i) => i.type).filter(Boolean))].sort();

// Pick list for an item's type. Anyone can add a new type; once saved on an
// item it shows up in the list for everyone.
const BASE_TYPES = ['Art', 'Books', 'Ceramics', 'Decor', 'Furniture', 'Glass', 'Kitchen', 'Lighting',
  'Object', 'Silver and metal', 'Textiles and rugs', 'Other'];
const typeChoices = () => [...new Set([...BASE_TYPES, ...types()])].sort((a, b) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
function typeSelectHtml(current, attrs = '') {
  const list = typeChoices();
  const cur = current || '';
  return `
    <span class="type-pick">
      <select class="select edit-val" ${attrs}>
        <option value="" ${cur ? '' : 'selected'}>Choose a type…</option>
        ${list.map((t) => `<option value="${esc(t)}" ${t === cur ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        ${cur && !list.includes(cur) ? `<option value="${esc(cur)}" selected>${esc(cur)}</option>` : ''}
        <option value="__new">Add a new type…</option>
      </select>
      <input class="input new-type" placeholder="New type, for example Clocks" hidden aria-label="New type" />
    </span>`;
}
// The value of a type picker: the chosen type, or the new one typed in.
function typeValue(box) {
  const sel = box.querySelector('.type-pick select');
  return sel.value === '__new' ? box.querySelector('.new-type').value.trim() : sel.value;
}
document.addEventListener('change', (e) => {
  const sel = e.target.closest('.type-pick select');
  if (!sel) return;
  const input = sel.parentElement.querySelector('.new-type');
  input.hidden = sel.value !== '__new';
  if (!input.hidden) input.focus();
});

const isPlaceholderName = (i) => /, photo \d+[a-z]?$/i.test(i.name) || i.name === i.room;
const needs = (i) => ({ name: isPlaceholderName(i), type: !i.type, description: !i.description });

// "Most wanted by Susan's family (best rank 2)", or several families when tied.
function bestLine(item) {
  if (item.overall_best == null) return '';
  const names = item.top_families.map((id) => `${familyName(id)}'s`);
  const who = names.length === 1 ? `${names[0]} family`
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} families (tied)`;
  return `Most wanted by ${esc(who)}, best rank ${item.overall_best}`;
}

// ------------------------------------------------------------------ layout

function shell(active, content) {
  const tabs = [
    ['browse', '#/', 'Browse'],
    ['family', '#/family', 'My family'],
    ['results', '#/results', 'Results'],
  ];
  if (state.me.is_editor) tabs.push(['fill', '#/fill', 'Add info']);
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
  if (!btn) return;
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
  const blank = { q: '', room: '', type: '', mine: 'all', interest: 'all', sort: 'catalog' };
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
    const fams = Object.keys(i.family_best).length;
    if (f.interest === 'none' && fams > 0) return false;
    if (f.interest === 'some' && fams === 0) return false;
    if (f.interest === 'multi' && fams < 2) return false;
    if (q && !`${i.name} ${i.id} ${i.room} ${i.type} ${i.subtype} ${i.description}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (f.sort === 'mine') list = [...list].sort((a, b) => (myRank(a) ?? 9) - (myRank(b) ?? 9));
  if (f.sort === 'wanted') list = [...list].sort((a, b) => (a.overall_best ?? 9) - (b.overall_best ?? 9)); // stable: ties stay in catalog order
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
        <li>Rank as many or as few as you like, and change them any time. Everyone in the family can see the ranks.</li>
        <li>Each family's best (lowest) number counts for that family. Results shows who wants what.</li>
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
    <p class="page-sub">${canRank() ? 'Tap 1 to 5 under anything you would like. 1 means you want it most, 5 means a little.' : 'Browse everything in the house and see who is interested.'}</p>
    ${welcomeCard()}
    ${canRank() ? progressBar() : ''}
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search by name, room or ID" value="${esc(f.q)}" data-f="q" aria-label="Search" />
      <div class="row">
        <select class="select" data-f="room" aria-label="Room">${opt('', 'All rooms', f.room)}${rooms().map((r) => opt(r, r, f.room)).join('')}</select>
        ${types().length ? `<select class="select" data-f="type" aria-label="Type">${opt('', 'All types', f.type)}${types().map((t) => opt(t, t, f.type)).join('')}</select>` : ''}
        ${canRank() ? `<select class="select" data-f="mine" aria-label="My ranks">${opt('all', 'Everything', f.mine)}${opt('unranked', 'Not yet ranked by me', f.mine)}${opt('ranked', 'Ranked by me', f.mine)}</select>` : ''}
        <select class="select" data-f="interest" aria-label="Interest">${opt('all', 'Any interest', f.interest)}${opt('none', 'Nobody has ranked it', f.interest)}${opt('some', 'Someone wants it', f.interest)}${opt('multi', 'Wanted by 2+ families', f.interest)}</select>
        <select class="select" data-f="sort" aria-label="Sort">${opt('catalog', 'Sort: catalog order', f.sort)}${opt('room', 'Sort: room', f.sort)}${opt('name', 'Sort: name A to Z', f.sort)}${opt('wanted', 'Sort: most wanted', f.sort)}${canRank() ? opt('mine', 'Sort: my ranks first', f.sort) : ''}</select>
      </div>
    </div>
    <p class="count" id="count"></p>
    <div class="grid" id="grid"></div>`);

  const draw = () => {
    if (!document.getElementById('grid')) return; // left the page before the search debounce fired
    const list = filteredItems(f);
    document.getElementById('count').textContent = `${list.length} of ${state.items.length} items`;
    document.getElementById('grid').innerHTML = list.length
      ? list.map((i) => `
        <article class="card">
          <a class="photo" href="#/item/${esc(i.id)}">${thumbImg(i)}</a>
          <div class="meta">
            <div class="room">${esc(i.room)}${i.hidden ? ' · hidden' : ''}</div>
            <a class="name" href="#/item/${esc(i.id)}">${esc(i.name)}</a>
            <div class="id">${esc(i.id)}</div>
            <div class="best" data-best="${esc(i.id)}">${bestLine(i)}</div>
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
  box.innerHTML = state.families.map((f) => {
    const best = item.family_best[String(f.id)];
    const ranked = f.members.filter((m) => item.ranks[String(m.id)] != null);
    const top = item.top_families.includes(f.id);
    return `
      <div class="fam">
        <div class="fam-head"><strong>${esc(f.name)}'s family</strong>
          <span>${best != null ? `Best ${best}${top ? ' <span class="top-tag">· most wanted</span>' : ''}` : '<span style="color:var(--faint)">No ranks yet</span>'}</span></div>
        <ul>${ranked.length ? ranked.map((m) => `<li>${esc(m.name)} <b>${item.ranks[String(m.id)]}</b></li>`).join('') : ''}</ul>
      </div>`;
  }).join('');
}

// The item page's back link returns to the list the person came from.
const BACK_LABELS = { '#/': 'The collection', '#/family': 'My family', '#/results': 'Results', '#/fill': 'Add info', '#/admin': 'Admin' };
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
        <div class="best" data-best="${esc(item.id)}">${bestLine(item)}</div>
        ${canRank() ? `<div class="rank-box">${rankerHtml(item, true)}</div>` : ''}
        <dl class="facts" id="facts"></dl>
        <h2 class="section-title">Who wants it</h2>
        <div class="who-ranked" id="who"></div>
        <h2 class="section-title">Edit history</h2>
        <button type="button" class="link-btn" id="show-history">Show changes</button>
        <ul class="history" id="history" hidden></ul>
        ${state.me.is_admin ? `
          <h2 class="section-title">Admin</h2>
          <button type="button" class="btn ghost small" id="toggle-hidden">${item.hidden ? 'Show this item to everyone' : 'Hide this item'}</button>
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
        <button type="button" class="link-btn" data-edit="${f}">Edit</button>
      </div>`).join('');
  };
  drawFacts();

  document.getElementById('facts').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      const f = editBtn.dataset.edit;
      const row = editBtn.closest('.fact');
      const multi = f === 'description';
      const label = FIELDS.find(([k]) => k === f)[1];
      row.innerHTML = `
        <dt id="lbl-${f}">${label}</dt>
        <div class="edit-box" style="grid-column: span 2" data-start="${esc(item[f])}">
          ${f === 'type' ? typeSelectHtml(item.type, `aria-labelledby="lbl-${f}"`)
            : multi ? `<textarea class="edit-val" aria-labelledby="lbl-${f}">${esc(item[f])}</textarea>`
            : `<input class="edit-val" aria-labelledby="lbl-${f}" value="${esc(item[f])}" />`}
          <div class="edit-actions">
            <button type="button" class="btn small" data-save="${f}">Save</button>
            <button type="button" class="btn ghost small" data-cancel>Cancel</button>
          </div>
        </div>`;
      row.querySelector('.edit-val').focus();
      return;
    }
    if (e.target.closest('[data-cancel]')) {
      const field = e.target.closest('.fact').dataset.field;
      drawFacts();
      document.querySelector(`[data-edit="${field}"]`)?.focus();
      return;
    }
    const save = e.target.closest('[data-save]');
    if (save) {
      const f = save.dataset.save;
      const boxEl = save.closest('.edit-box');
      const val = f === 'type' ? typeValue(boxEl) : boxEl.querySelector('.edit-val').value;
      save.disabled = true;
      try {
        const res = await state.api.editItem(item.id, f, val, boxEl.dataset.start);
        item[f] = res.value;
        if (f === 'name') document.getElementById('title').textContent = item.name;
        if (res.conflict) {
          // Someone else saved first. Show their version and keep what this person typed.
          boxEl.dataset.start = res.value ?? '';
          save.disabled = false;
          boxEl.querySelector('.conflict-note')?.remove();
          boxEl.insertAdjacentHTML('afterbegin', `<p class="conflict-note">${esc(res.by || 'Someone')} changed this while you were editing. It now says: “${esc(res.value || '—')}”. Tap Save again to replace it with your text, or Cancel to keep theirs.</p>`);
          return;
        }
        drawFacts();
        if (!document.getElementById('history').hidden) loadHistory();
        toast('Saved');
      } catch (err) {
        if (!state.me) return;
        toast(err.message, true);
        save.disabled = false;
      }
    }
  });

  document.getElementById('facts').addEventListener('keydown', (e) => {
    const box = e.target.closest('.edit-box');
    if (!box) return;
    if (e.key === 'Escape') { e.preventDefault(); box.querySelector('[data-cancel]').click(); }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); box.querySelector('[data-save]').click(); }
  });

  const loadHistory = async () => {
    const ul = document.getElementById('history');
    ul.hidden = false;
    ul.innerHTML = '<li class="loading">Loading…</li>';
    try {
      const rows = await state.api.history(item.id);
      ul.innerHTML = rows.length
        ? rows.map((r) => `<li><b>${esc(r.by)}</b> changed ${esc(r.field)} on ${esc(fmtDate(r.at))}<br>from “${esc(r.old || '—')}” to “${esc(r.new || '—')}”</li>`).join('')
        : '<li>No changes yet.</li>';
    } catch (err) {
      ul.innerHTML = `<li>${esc(err.message)}</li>`;
    }
  };
  document.getElementById('show-history').addEventListener('click', (e) => { e.target.remove(); loadHistory(); });

  document.getElementById('toggle-hidden')?.addEventListener('click', async (e) => {
    try {
      await state.api.adminSetHidden(item.id, !item.hidden);
      item.hidden = !item.hidden;
      e.target.textContent = item.hidden ? 'Show this item to everyone' : 'Hide this item';
      toast(item.hidden ? 'Hidden from family members' : 'Visible to everyone');
    } catch (err) { toast(err.message, true); }
  });

  renderWhoRanked(item);
  window.scrollTo(0, 0);
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
  const f = loadView('fi_family', { q: '', room: '', type: '', who: 'any', sort: 'best' });
  shell('family', `
    <h1 class="page-title">${esc(fam.name)}'s family</h1>
    <p class="page-sub">What everyone in your family has ranked. The family best is the lowest number any of you gave.</p>
    ${tableToolbar(f, (opt) => `
      <select class="select" data-f="who" aria-label="Show">${opt('any', 'Ranked by anyone in the family', f.who)}${opt('me', 'Ranked by me', f.who)}${fam.members.filter((m) => m.id !== state.me.id).map((m) => opt(String(m.id), `Ranked by ${m.name}`, f.who)).join('')}${opt('notme', 'Family ranked, I have not', f.who)}${opt('all', 'All items', f.who)}</select>
      <select class="select" data-f="sort" aria-label="Sort">${opt('best', 'Sort: family best', f.sort)}${opt('mine', 'Sort: my rank', f.sort)}${opt('catalog', 'Sort: catalog order', f.sort)}${opt('room', 'Sort: room', f.sort)}${opt('name', 'Sort: name A to Z', f.sort)}</select>`)}
    <p class="count" id="count"></p>
    <div class="table-wrap"><table class="data" id="tbl"></table></div>`);

  const famRanked = (i) => fam.members.some((m) => i.ranks[String(m.id)] != null);
  const draw = () => {
    if (!document.getElementById('tbl')) return;
    const q = f.q.trim().toLowerCase();
    let rows = state.items.filter((i) => {
      if (f.room && i.room !== f.room) return false;
      if (f.type && i.type !== f.type) return false;
      if (!matchesQuery(i, q)) return false;
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
    document.getElementById('count').textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}`;
    document.getElementById('tbl').innerHTML = `
      <thead><tr><th>Item</th><th class="num key">Family best</th>${fam.members.map((m) => `<th class="num ${m.id === state.me.id ? 'me-col' : ''}">${m.id === state.me.id ? 'You' : esc(m.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((i) => `<tr><td class="item-cell">${miniItem(i)}</td><td class="num key">${rankCell(i.family_best[String(fam.id)])}</td>${fam.members.map((m) => `<td class="num ${m.id === state.me.id ? 'me-col' : ''}">${rankCell(i.ranks[String(m.id)])}</td>`).join('')}</tr>`).join('')
        || `<tr><td colspan="${fam.members.length + 2}" class="empty-state">Nothing matches. Try another filter.</td></tr>`}</tbody>`;
  };
  draw();
  wireToolbar(f, 'fi_family', draw);
}

// ------------------------------------------------------------------ results

function renderResults() {
  const f = loadView('fi_results', { q: '', room: '', type: '', view: 'ranked', fam: '', sort: 'best' });
  shell('results', `
    <h1 class="page-title">Results</h1>
    <p class="page-sub">For each item: the best (lowest) rank anyone gave, which family wants it most, and each family's best rank. Ties are listed together.</p>
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
      <tbody>${rows.map((i) => `<tr><td class="item-cell">${miniItem(i)}</td><td class="num key">${rankCell(i.overall_best)}</td><td class="key who">${esc(i.top_families.map(familyName).join(', '))}</td>${state.families.map((fm) => `<td class="num">${rankCell(i.family_best[String(fm.id)])}</td>`).join('')}</tr>`).join('')
        || `<tr><td colspan="${state.families.length + 3}" class="empty-state">Nothing matches. Try another filter.</td></tr>`}</tbody>`;
  };
  draw();
  wireToolbar(f, 'fi_results', draw);
  document.getElementById('csv')?.addEventListener('click', downloadCsv);
}

function downloadCsv() {
  const people = state.families.flatMap((f) => f.members.map((m) => ({ ...m, fam: f })));
  const head = ['Item ID', 'Name', 'Room', 'Photo #', 'Type', 'Subtype', 'Origin', 'Description', 'Hidden',
    ...people.map((p) => `${p.fam.name}: ${p.name}`), ...state.families.map((f) => `${f.name} best`), 'Overall best', 'Top interest'];
  const cell = (v) => {
    let s = String(v ?? '');
    // Keep spreadsheet apps from running a value as a formula.
    if (/^[=+\-@\t\r]/.test(s) || /[\r\n]\s*[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head.map(cell).join(',')];
  for (const i of state.items) {
    lines.push([i.id, i.name, i.room, i.photo_no, i.type, i.subtype, i.origin, i.description, i.hidden ? 'yes' : '',
      ...people.map((p) => i.ranks[String(p.id)] ?? ''), ...state.families.map((f) => i.family_best[String(f.id)] ?? ''),
      i.overall_best ?? '', i.top_families.map(familyName).join(' & ')].map(cell).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `family-inventory-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ------------------------------------------------------------------ add info
//
// One item at a time, with a big photo and every field ready to type in.
// Items with a suggestion written from the photo come prefilled; nothing is
// saved until the editor taps Save.

const FILL = 'fi_fill';
function loadFill() {
  const blank = { show: 'needs', room: '', q: '', at: '' };
  try { return { ...blank, ...JSON.parse(getStored(FILL, 'sessionStorage') || '{}') }; } catch { return blank; }
}

function fillQueue(f) {
  const q = f.q.trim().toLowerCase();
  return state.items.filter((i) => {
    const n = needs(i);
    if (f.room && i.room !== f.room) return false;
    if (q && !`${i.name} ${i.id} ${i.room} ${i.type} ${i.description}`.toLowerCase().includes(q)) return false;
    if (f.show === 'needs') return n.name || n.type || n.description;
    if (f.show === 'name') return n.name;
    if (f.show === 'type') return n.type;
    if (f.show === 'description') return n.description;
    if (f.show === 'draft') return !!i.draft;
    return true;
  });
}

function renderFill() {
  if (!state.me.is_editor) { location.hash = '#/'; return; }
  const f = loadFill();
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  const counts = state.items.reduce((c, i) => { const n = needs(i); c.name += n.name; c.type += n.type; c.description += n.description; c.draft += !!i.draft; return c; }, { name: 0, type: 0, description: 0, draft: 0 });
  shell('fill', `
    <h1 class="page-title">Add info</h1>
    <p class="page-sub">${counts.name} items still need a name, ${counts.type} need a type and ${counts.description} need a description.
      ${counts.draft ? `${counts.draft} have a suggestion written from the photo for you to check.` : ''}</p>
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search by name, room or ID" value="${esc(f.q)}" data-f="q" aria-label="Search" />
      <div class="row">
        <select class="select" data-f="show" aria-label="Show">
          ${opt('needs', 'Anything missing', f.show)}${opt('draft', 'Has a suggestion', f.show)}${opt('name', 'Needs a name', f.show)}${opt('type', 'Needs a type', f.show)}${opt('description', 'Needs a description', f.show)}${opt('all', 'All items', f.show)}
        </select>
        <select class="select" data-f="room" aria-label="Room">${opt('', 'All rooms', f.room)}${rooms().map((r) => opt(r, r, f.room)).join('')}</select>
      </div>
    </div>
    <div id="fill"></div>`);

  const save = () => setStored(FILL, JSON.stringify(f), 'sessionStorage');
  let queue = fillQueue(f);

  const draw = () => {
    const box = document.getElementById('fill');
    if (!box) return;
    if (!queue.length) {
      box.innerHTML = `<div class="empty-state"><p>Nothing left here. ${f.show === 'all' ? '' : 'Try "All items" to look through everything.'}</p></div>`;
      return;
    }
    let idx = queue.findIndex((i) => i.id === f.at);
    if (idx < 0) { idx = 0; f.at = queue[0].id; save(); }
    const item = queue[idx];
    const d = item.draft || {};
    const val = (k) => (k === 'name' ? (isPlaceholderName(item) ? (d.name || '') : item.name) : (item[k] || d[k] || ''));
    const fromDraft = (k) => item.draft && d[k] && (k === 'name' ? isPlaceholderName(item) : !item[k]);
    const p = photoOf(item);
    const mark = (k) => (fromDraft(k) ? ' <span class="suggested">suggested</span>' : '');
    box.innerHTML = `
      <p class="count">${idx + 1} of ${queue.length}</p>
      <div class="fill-item" data-id="${esc(item.id)}">
        <div class="fill-photo">${p?.full ? `<img src="${esc(p.full)}" alt="${esc(item.name)}" />` : '<div class="placeholder">Photo coming</div>'}</div>
        <form class="fill-form" autocomplete="off">
          <div class="eyebrow">${esc(item.room)}${item.photo_no ? ` · Photo ${esc(item.photo_no)}` : ''} · <a href="#/item/${esc(item.id)}">${esc(item.id)}</a></div>
          ${item.draft ? '<p class="draft-note">Suggested from the photo. Check it, fix anything that is wrong, then save.</p>' : ''}
          ${isPlaceholderName(item) ? `<p class="now">Now called “${esc(item.name)}”</p>` : ''}
          <label>Name${mark('name')}<input class="input" name="name" value="${esc(val('name'))}" placeholder="For example: Blue and white teapot" /></label>
          <label class="fill-type">Type${mark('type')}${typeSelectHtml(val('type'))}</label>
          <label>Subtype${mark('subtype')}<input class="input" name="subtype" value="${esc(val('subtype'))}" placeholder="For example: Painting, Print, Chair" /></label>
          <label>Origin<input class="input" name="origin" value="${esc(item.origin)}" placeholder="Where it came from, who made it" /></label>
          <label>Description${mark('description')}<textarea class="input" name="description" rows="4">${esc(val('description'))}</textarea></label>
          <p class="conflict-note" hidden></p>
          <div class="fill-actions">
            <button type="submit" class="btn">Save and next</button>
            <button type="button" class="btn ghost" data-go="1">Skip</button>
            ${idx > 0 ? '<button type="button" class="btn ghost" data-go="-1">Back</button>' : ''}
            ${item.draft ? '<button type="button" class="link-btn" data-discard>Suggestion is wrong, discard it</button>' : ''}
          </div>
        </form>
      </div>`;
    const form = box.querySelector('form');
    form.querySelector('[name="name"]').focus({ preventScroll: true });

    const go = (step) => {
      const at = queue.findIndex((i) => i.id === item.id);
      queue = fillQueue(f);
      const pos = queue.findIndex((i) => i.id === item.id);
      const next = pos >= 0 ? queue[pos + step] : queue[Math.max(0, Math.min(at, queue.length - 1) + (step < 0 ? -1 : 0))];
      f.at = (next || queue[0])?.id || '';
      save();
      draw();
      window.scrollTo(0, 0);
    };
    box.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.go))));
    box.querySelector('[data-discard]')?.addEventListener('click', async () => {
      try { await state.api.draftDone(item.id, 'dismissed'); item.draft = null; toast('Suggestion discarded'); draw(); }
      catch (err) { if (state.me) toast(err.message, true); }
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type="submit"]');
      const note = form.querySelector('.conflict-note');
      const want = {
        name: form.elements.namedItem('name').value.trim(),
        type: typeValue(form),
        subtype: form.elements.namedItem('subtype').value.trim(),
        origin: form.elements.namedItem('origin').value.trim(),
        description: form.elements.namedItem('description').value.trim(),
      };
      if (!want.name) want.name = item.name; // a blank name keeps the old one
      btn.disabled = true;
      try {
        for (const [k, v] of Object.entries(want)) {
          if (v === (item[k] || '')) continue;
          const res = await state.api.editItem(item.id, k, v, item[k] || '');
          item[k] = res.value;
          if (res.conflict) {
            note.hidden = false;
            note.textContent = `${res.by || 'Someone'} changed the ${k} while you were working. It now says “${res.value || '—'}”. Check it, then tap Save again.`;
            const field = k === 'type' ? null : form.querySelector(`[name="${k}"]`);
            if (field) field.value = res.value || '';
            btn.disabled = false;
            return;
          }
        }
        if (item.draft) { await state.api.draftDone(item.id, 'used'); item.draft = null; }
        toast('Saved');
        go(1);
      } catch (err) {
        if (state.me) toast(err.message, true);
        btn.disabled = false;
      }
    });
  };
  draw();

  let t;
  app.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', () => {
    f[el.dataset.f] = el.value;
    save();
    clearTimeout(t);
    t = setTimeout(() => { queue = fillQueue(f); draw(); }, el.dataset.f === 'q' ? 200 : 0);
  }));
}

// ------------------------------------------------------------------ admin

async function renderAdmin() {
  if (!state.me.is_admin) { location.hash = '#/'; return; }
  shell('admin', `
    <h1 class="page-title">Admin</h1>
    <p class="page-sub">Make a personal link for each person and send it by text or email. Making a new link turns off that person's old one. "Can add info" gives someone the Add info screen for naming and describing items.</p>
    <div class="admin-sections">
      <section>
        <div class="eyebrow" style="margin-bottom:8px">People</div>
        <p class="people-summary" id="people-summary"></p>
        <div class="people" id="people"><p class="loading">Loading…</p></div>
      </section>
      <section>
        <div class="eyebrow" style="margin-bottom:8px">Items</div>
        <p style="font-size:14px;color:var(--muted)">${state.items.length} items, ${state.items.filter((i) => i.hidden).length} hidden. Open any item to edit it or hide it. Download everything from <a href="#/results">Results</a>.</p>
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
          <div class="d">${esc(p.family ? `${p.family}'s family · ${p.role}` : p.role)}${p.is_admin && p.role !== 'admin' ? ' · admin' : ''} ·
            ${p.has_link ? (p.last_seen_at ? `last opened ${esc(fmtDate(p.last_seen_at))}` : 'link not opened yet') : 'no link yet'}
            · ${p.ranked} ranked</div>
        </div>
        <div class="actions">
          <button type="button" class="btn small ${p.has_link ? 'ghost' : ''}" data-new="${p.id}">${p.has_link ? 'New link' : 'Make link'}</button>
          ${p.has_link && p.id !== state.me.id ? `<button type="button" class="btn ghost small" data-off="${p.id}">Turn off</button>` : ''}
          ${p.is_admin ? '' : `<button type="button" class="chip" data-editor="${p.id}" aria-pressed="${!!p.is_editor}">Can add info</button>`}
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
    const eb = e.target.closest('[data-editor]');
    if (eb) {
      const p = people.find((x) => x.id === Number(eb.dataset.editor));
      try {
        await state.api.adminSetEditor(p.id, !p.is_editor);
        p.is_editor = !p.is_editor;
        eb.setAttribute('aria-pressed', String(p.is_editor));
        toast(p.is_editor ? `${p.name} can now use Add info` : `${p.name} no longer sees Add info`);
      } catch (err) { if (state.me) toast(err.message, true); }
      return;
    }
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
  if (h === '/admin') return { name: 'admin' };
  if (h === '/fill') return { name: 'fill' };
  return { name: 'browse' };
}

let lastRoute = null;
function route() {
  if (!state.me) return;
  const r = currentRoute();
  if (r.name === 'item') renderItem(r.id);
  else if (r.name === 'family') renderFamily();
  else if (r.name === 'results') renderResults();
  else if (r.name === 'admin') renderAdmin();
  else if (r.name === 'fill') renderFill();
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
  if (document.querySelector('.edit-box, .new-link, .lightbox')) return;
  try {
    const data = await state.api.load();
    if (!state.me || savesInFlight || document.querySelector('.edit-box, .new-link, .lightbox')) return;
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
