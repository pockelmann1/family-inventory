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

function personalLink(key) {
  return `${location.origin}${BASE}#k=${key}`;
}

// ------------------------------------------------------------------ sign-in

// A personal link looks like .../family-inventory/#k=KEY (or ?k=KEY). The key
// is remembered on this device and removed from the address bar.
function takeKeyFromUrl() {
  const fromHash = location.hash.match(/[#&]k=([A-Za-z0-9_-]{20,})/);
  const fromQuery = new URLSearchParams(location.search).get('k');
  const key = fromHash?.[1] || (fromQuery && /^[A-Za-z0-9_-]{20,}$/.test(fromQuery) ? fromQuery : null);
  if (key) {
    setStored(KEY_STORE, key);
    history.replaceState(null, '', `${BASE}#/`);
  }
  return key;
}

let memoryKey = takeKeyFromUrl();
const currentKey = () => memoryKey || getStored(KEY_STORE);

function showSignedOut(message) {
  app.innerHTML = `
    <div class="center-box">
      <p class="eyebrow">Family Inventory</p>
      <h1>Welcome</h1>
      <p>${esc(message || 'Please open the personal link you were sent by text or email. It signs you in on this device.')}</p>
    </div>`;
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

function bestLine(item) {
  if (item.overall_best == null) return '';
  const names = item.top_families.map(familyName).join(' & ');
  return `Top interest: ${esc(names)} (${item.overall_best})`;
}

// ------------------------------------------------------------------ layout

function shell(active, content) {
  const tabs = [
    ['browse', '#/', 'Browse'],
    ['family', '#/family', 'My family'],
    ['results', '#/results', 'Results'],
  ];
  if (state.me.is_admin) tabs.push(['admin', '#/admin', 'Admin']);
  app.innerHTML = `
    <header class="site-header">
      <div class="inner">
        <a class="wordmark" href="#/">Family Inventory</a>
        <span class="whoami">${esc(state.me.name)}</span>
        <nav class="nav" aria-label="Main">
          ${tabs.map(([k, href, label]) => `<a href="${href}" class="${k === active ? 'active' : ''}">${label}</a>`).join('')}
        </nav>
      </div>
    </header>
    <main id="main">${content}</main>
    <footer class="site-footer">Signed in as ${esc(state.me.name)}. Ranks: 1 means most wanted.</footer>`;
}

function rankerHtml(item, large = false) {
  if (!canRank()) return '';
  const mine = myRank(item);
  return `
    <div class="ranker${large ? ' large' : ''}" data-item="${esc(item.id)}" role="group" aria-label="My rank for ${esc(item.name)}">
      ${large ? '<span class="label">My rank <span class="hint">1 = want most</span></span>' : ''}
      ${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-rank="${n}" aria-pressed="${mine === n}" aria-label="Rank ${n}">${n}</button>`).join('')}
      ${large && mine != null ? '<button type="button" class="clear" data-rank="">Clear</button>' : ''}
    </div>`;
}

function thumbImg(item, cls = '') {
  const p = photoOf(item);
  if (!p?.thumb) return `<div class="placeholder ${cls}">Photo coming</div>`;
  return `<img class="${cls}" src="${esc(p.thumb)}" alt="${esc(item.name)}" loading="lazy" decoding="async" />`;
}

// Rank clicks anywhere on the page.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.ranker button[data-rank]');
  if (!btn) return;
  e.preventDefault();
  const box = btn.closest('.ranker');
  const item = state.byId.get(box.dataset.item);
  if (!item) return;
  const want = btn.dataset.rank === '' ? null : Number(btn.dataset.rank);
  const next = want === myRank(item) ? null : want; // tapping the same number clears it
  box.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    const res = await state.api.setRank(item.id, next);
    Object.assign(item, res);
    box.outerHTML = rankerHtml(item, box.classList.contains('large'));
    document.querySelectorAll(`[data-best="${CSS.escape(item.id)}"]`).forEach((el) => (el.innerHTML = bestLine(item)));
    if (currentRoute().name === 'item') renderWhoRanked(item);
    toast(next == null ? 'Rank cleared' : `Ranked ${next}`);
  } catch (err) {
    toast(err.message, true);
    box.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
});

// ------------------------------------------------------------------ browse

const FILTERS = 'fi_browse';
function loadFilters() {
  try { return { q: '', room: '', type: '', mine: 'all', sort: 'catalog', ...JSON.parse(getStored(FILTERS, 'sessionStorage') || '{}') }; }
  catch { return { q: '', room: '', type: '', mine: 'all', sort: 'catalog' }; }
}

function filteredItems(f) {
  const q = f.q.trim().toLowerCase();
  let list = state.items.filter((i) => {
    if (f.room && i.room !== f.room) return false;
    if (f.type && i.type !== f.type) return false;
    if (f.mine === 'unranked' && myRank(i) != null) return false;
    if (f.mine === 'ranked' && myRank(i) == null) return false;
    if (q && !`${i.name} ${i.id} ${i.room} ${i.type} ${i.subtype} ${i.description}`.toLowerCase().includes(q)) return false;
    return true;
  });
  if (f.sort === 'mine') list = [...list].sort((a, b) => (myRank(a) ?? 9) - (myRank(b) ?? 9));
  if (f.sort === 'wanted') list = [...list].sort((a, b) => (a.overall_best ?? 9) - (b.overall_best ?? 9) || b.top_families.length - a.top_families.length);
  return list;
}

function renderBrowse() {
  const f = loadFilters();
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  shell('browse', `
    <h1 class="page-title">The Collection</h1>
    <p class="page-sub">${canRank() ? 'Tap 1 to 5 under anything you would like. 1 means you want it most. Tap your number again to clear it.' : 'Browse everything in the house and see who is interested.'}</p>
    <div class="toolbar">
      <input class="input search" type="search" placeholder="Search by name, room or ID" value="${esc(f.q)}" data-f="q" aria-label="Search" />
      <div class="row">
        <select class="select" data-f="room" aria-label="Room">${opt('', 'All rooms', f.room)}${rooms().map((r) => opt(r, r, f.room)).join('')}</select>
        ${types().length ? `<select class="select" data-f="type" aria-label="Type">${opt('', 'All types', f.type)}${types().map((t) => opt(t, t, f.type)).join('')}</select>` : ''}
        ${canRank() ? `<select class="select" data-f="mine" aria-label="My ranks">${opt('all', 'Everything', f.mine)}${opt('unranked', 'Not yet ranked by me', f.mine)}${opt('ranked', 'Ranked by me', f.mine)}</select>` : ''}
        <select class="select" data-f="sort" aria-label="Sort">${opt('catalog', 'Catalog order', f.sort)}${opt('wanted', 'Most wanted', f.sort)}${canRank() ? opt('mine', 'My ranks first', f.sort) : ''}</select>
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

  const y = Number(getStored('fi_scroll', 'sessionStorage') || 0);
  if (y) requestAnimationFrame(() => window.scrollTo(0, y));
}

document.addEventListener('click', (e) => {
  if (e.target.id !== 'clear-filters') return;
  setStored(FILTERS, null, 'sessionStorage');
  renderBrowse();
});

window.addEventListener('scroll', () => {
  if (currentRoute().name === 'browse') setStored('fi_scroll', String(window.scrollY), 'sessionStorage');
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
          <span>${best != null ? `Best ${best}${top ? ' <span class="top-tag">· top interest</span>' : ''}` : '<span style="color:var(--faint)">No ranks yet</span>'}</span></div>
        <ul>${ranked.length ? ranked.map((m) => `<li>${esc(m.name)} <b>${item.ranks[String(m.id)]}</b></li>`).join('') : ''}</ul>
      </div>`;
  }).join('');
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
    <a class="back" href="#/">&larr; The collection</a>
    <div class="item-page">
      <div>
        <div class="stage" id="stage"></div>
        ${item.photos.length > 1 ? `<div class="thumbs" id="thumbs">${item.photos.map((p, n) => `<button type="button" data-n="${n}" aria-label="Photo ${n + 1}">${p.thumb ? `<img src="${esc(p.thumb)}" alt="" />` : ''}</button>`).join('')}</div>` : ''}
        <div class="pager">
          ${prev ? `<a href="#/item/${esc(prev.id)}">&larr; Previous</a>` : '<span></span>'}
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
  stage.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    sx = null;
    if (Math.abs(dx) < 60) return;
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
      row.innerHTML = `
        <dt>${FIELDS.find(([k]) => k === f)[1]}</dt>
        <div class="edit-box" style="grid-column: span 2">
          ${multi ? `<textarea id="edit-val">${esc(item[f])}</textarea>` : `<input id="edit-val" value="${esc(item[f])}" />`}
          <div class="edit-actions">
            <button type="button" class="btn small" data-save="${f}">Save</button>
            <button type="button" class="btn ghost small" data-cancel>Cancel</button>
          </div>
        </div>`;
      row.querySelector('#edit-val').focus();
      return;
    }
    if (e.target.closest('[data-cancel]')) { drawFacts(); return; }
    const save = e.target.closest('[data-save]');
    if (save) {
      const f = save.dataset.save;
      const val = document.getElementById('edit-val').value;
      save.disabled = true;
      try {
        const res = await state.api.editItem(item.id, f, val);
        item[f] = res.value;
        if (f === 'name') document.getElementById('title').textContent = item.name;
        drawFacts();
        if (!document.getElementById('history').hidden) loadHistory();
        toast('Saved');
      } catch (err) {
        toast(err.message, true);
        save.disabled = false;
      }
    }
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

function renderFamily() {
  const fam = state.families.find((f) => f.id === state.me.family_id);
  if (!fam) {
    shell('family', `<h1 class="page-title">My family</h1><p class="page-sub">You are not part of a sibling family, so there is nothing to show here. See Results for everyone.</p>`);
    return;
  }
  let showAll = getStored('fi_fam_all', 'sessionStorage') === '1';
  shell('family', `
    <h1 class="page-title">${esc(fam.name)}'s family</h1>
    <p class="page-sub">What everyone in your family has ranked. The family best is the lowest number any of you gave.</p>
    <div class="toolbar"><div class="row">
      <button type="button" class="chip" id="all" aria-pressed="${showAll}">Show unranked items too</button>
    </div></div>
    <p class="count" id="count"></p>
    <div class="table-wrap"><table class="data" id="tbl"></table></div>`);

  const draw = () => {
    const rows = state.items.filter((i) => showAll || fam.members.some((m) => i.ranks[String(m.id)] != null));
    document.getElementById('count').textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}`;
    document.getElementById('tbl').innerHTML = `
      <thead><tr><th>Item</th><th class="num key">Family best</th>${fam.members.map((m) => `<th class="num ${m.id === state.me.id ? 'me-col' : ''}">${m.id === state.me.id ? 'You' : esc(m.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((i) => `<tr><td class="item-cell">${miniItem(i)}</td><td class="num key">${rankCell(i.family_best[String(fam.id)])}</td>${fam.members.map((m) => `<td class="num ${m.id === state.me.id ? 'me-col' : ''}">${rankCell(i.ranks[String(m.id)])}</td>`).join('')}</tr>`).join('')
        || `<tr><td colspan="${fam.members.length + 2}" class="empty-state">Nobody in your family has ranked anything yet.</td></tr>`}</tbody>`;
  };
  draw();
  document.getElementById('all').addEventListener('click', (e) => {
    showAll = !showAll;
    setStored('fi_fam_all', showAll ? '1' : '0', 'sessionStorage');
    e.target.setAttribute('aria-pressed', String(showAll));
    draw();
  });
}

// ------------------------------------------------------------------ results

function renderResults() {
  const f = { room: '', view: 'ranked', ...JSON.parse(getStored('fi_results', 'sessionStorage') || '{}') };
  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  shell('results', `
    <h1 class="page-title">Results</h1>
    <p class="page-sub">Each family's best rank per item, the overall best, and the family or families with the highest interest. Ties are listed together.</p>
    <div class="toolbar"><div class="row">
      <select class="select" data-f="view" aria-label="Show">${opt('ranked', 'Items anyone ranked', f.view)}${opt('multi', 'Wanted by 2 or more families', f.view)}${opt('all', 'All items', f.view)}</select>
      <select class="select" data-f="room" aria-label="Room">${opt('', 'All rooms', f.room)}${rooms().map((r) => opt(r, r, f.room)).join('')}</select>
      ${state.me.is_admin ? '<button type="button" class="chip" id="csv">Download CSV</button>' : ''}
    </div></div>
    <p class="count" id="count"></p>
    <div class="table-wrap"><table class="data" id="tbl"></table></div>`);

  const draw = () => {
    let rows = state.items.filter((i) => (!f.room || i.room === f.room));
    if (f.view === 'ranked') rows = rows.filter((i) => i.overall_best != null);
    if (f.view === 'multi') rows = rows.filter((i) => Object.keys(i.family_best).length >= 2);
    rows = [...rows].sort((a, b) => (a.overall_best ?? 9) - (b.overall_best ?? 9) || a.id.localeCompare(b.id));
    document.getElementById('count').textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}`;
    document.getElementById('tbl').innerHTML = `
      <thead><tr><th>Item</th><th class="num key">Best</th><th class="key">Top interest</th>${state.families.map((fm) => `<th class="num">${esc(fm.name)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((i) => `<tr><td class="item-cell">${miniItem(i)}</td><td class="num key">${rankCell(i.overall_best)}</td><td class="key who">${esc(i.top_families.map(familyName).join(', '))}</td>${state.families.map((fm) => `<td class="num">${rankCell(i.family_best[String(fm.id)])}</td>`).join('')}</tr>`).join('')
        || `<tr><td colspan="${state.families.length + 3}" class="empty-state">No ranks yet.</td></tr>`}</tbody>`;
  };
  draw();
  app.querySelectorAll('[data-f]').forEach((el) => el.addEventListener('input', () => {
    f[el.dataset.f] = el.value;
    setStored('fi_results', JSON.stringify(f), 'sessionStorage');
    draw();
  }));
  document.getElementById('csv')?.addEventListener('click', downloadCsv);
}

function downloadCsv() {
  const people = state.families.flatMap((f) => f.members.map((m) => ({ ...m, fam: f })));
  const head = ['Item ID', 'Name', 'Room', 'Photo #', 'Type', 'Subtype', 'Origin', 'Description', 'Hidden',
    ...people.map((p) => `${p.fam.name}: ${p.name}`), ...state.families.map((f) => `${f.name} best`), 'Overall best', 'Top interest'];
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = `'${s}`; // keep spreadsheet apps from running it as a formula
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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

// ------------------------------------------------------------------ admin

async function renderAdmin() {
  if (!state.me.is_admin) { location.hash = '#/'; return; }
  shell('admin', `
    <h1 class="page-title">Admin</h1>
    <p class="page-sub">Make a personal link for each person and send it by text or email. Making a new link turns off that person's old one.</p>
    <div class="admin-sections">
      <section>
        <div class="eyebrow" style="margin-bottom:8px">People</div>
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
        </div>
      </div>`).join('');
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
    if (nb) {
      const p = people.find((x) => x.id === Number(nb.dataset.new));
      if (p.has_link && !confirmInline(nb, `This turns off ${p.name}'s current link. Tap again to continue.`)) return;
      nb.disabled = true;
      try {
        const key = await state.api.adminNewLink(p.id);
        p.has_link = true;
        p.last_seen_at = null;
        if (p.id === state.me.id) { memoryKey = key; setStored(KEY_STORE, key); state.api = makeApi(key); }
        draw();
        showNewLink(p, key);
      } catch (err) { toast(err.message, true); nb.disabled = false; }
    }
    if (ob) {
      const p = people.find((x) => x.id === Number(ob.dataset.off));
      if (!confirmInline(ob, `Turn off ${p.name}'s link? Tap again to confirm.`)) return;
      try {
        await state.api.adminTurnOffLink(p.id);
        p.has_link = false;
        draw();
        toast(`${p.name}'s link is off`);
      } catch (err) { toast(err.message, true); }
    }
  });

  function showNewLink(p, key) {
    const link = personalLink(key);
    const row = box.querySelector(`.person[data-id="${p.id}"]`);
    const msg = `Hi ${p.name}, here is your personal link to the family inventory. Please don't share it: ${link}`;
    const div = document.createElement('div');
    div.className = 'new-link';
    div.innerHTML = `
      <strong>${esc(p.name)}'s new link</strong> (shown once, so send it now)
      <code>${esc(link)}</code>
      <div class="actions">
        <button type="button" class="btn small" data-copy>Copy link</button>
        ${navigator.share ? '<button type="button" class="btn ghost small" data-share>Share…</button>' : ''}
        <a class="btn ghost small" style="display:inline-flex;align-items:center;text-decoration:none" href="sms:?&body=${encodeURIComponent(msg)}">Text</a>
        <a class="btn ghost small" style="display:inline-flex;align-items:center;text-decoration:none" href="mailto:?subject=${encodeURIComponent('Your family inventory link')}&body=${encodeURIComponent(msg)}">Email</a>
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
  return { name: 'browse' };
}

function route() {
  if (!state.me) return;
  const r = currentRoute();
  if (r.name !== 'browse' && r.name !== 'item') window.scrollTo(0, 0);
  if (r.name === 'item') renderItem(r.id);
  else if (r.name === 'family') renderFamily();
  else if (r.name === 'results') renderResults();
  else if (r.name === 'admin') renderAdmin();
  else renderBrowse();
}

window.addEventListener('hashchange', () => {
  const k = takeKeyFromUrl();
  if (k) { memoryKey = k; start(); return; }
  route();
});

// Pick up other people's new ranks when the page comes back into view.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.api || Date.now() - state.loadedAt < 120000) return;
  if (document.querySelector('.edit-box, .new-link, .lightbox')) return;
  try { ingest(await state.api.load()); route(); } catch { /* keep what we have */ }
});

async function start() {
  const key = currentKey();
  if (!key) { showSignedOut(); return; }
  app.innerHTML = '<p class="loading">Loading the collection…</p>';
  state.api = makeApi(key);
  try {
    ingest(await state.api.load());
  } catch (err) {
    if (err.invalidLink) {
      setStored(KEY_STORE, null);
      memoryKey = null;
      showSignedOut('This link no longer works. Please ask Paul for a new one.');
    } else {
      app.innerHTML = `<div class="center-box"><h1>Sorry</h1><p>${esc(err.message)}</p><p><button class="btn" onclick="location.reload()">Try again</button></p></div>`;
    }
    return;
  }
  route();
}

start();
