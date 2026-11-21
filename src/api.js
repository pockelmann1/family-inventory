// Talks to the Supabase database. The publishable key below is public by
// design: it can only call the fi_* functions, and each of those checks the
// caller's personal link key before doing anything.
const SUPABASE_URL = 'https://joclsntnnmtzzeippxhp.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_l1slwkNY7ofygcwQWt4QrA_-FazT4jv';

export class ApiError extends Error {
  constructor(message, status) {
    const invalidLink = /invalid link/i.test(message);
    super(invalidLink ? 'This link no longer works.' : message);
    this.status = status;
    this.invalidLink = invalidLink;
  }
}

const TIMEOUT_MS = 20000;

async function rpc(fn, args) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  let text;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
      signal: ctl.signal,
    });
    text = await res.text();
  } catch {
    throw new ApiError(ctl.signal.aborted
      ? 'The connection is too slow right now. Please try again in a moment.'
      : 'Could not reach the server. Check your connection and try again.', 0);
  } finally {
    clearTimeout(timer);
  }
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {
    // Hotel and airport Wi-Fi often answer with their own sign-in page.
    throw new ApiError('The connection returned an unexpected page. If you are on public Wi-Fi, sign in to it first, then try again.', res.status);
  }
  if (!res.ok) throw new ApiError(body?.message || `Something went wrong (${res.status}). Please try again.`, res.status);
  return body;
}

// onInvalidLink runs whenever the server says this link has been turned off
// or replaced, so every screen signs the person out the same way.
export function makeApi(key, onInvalidLink = () => {}) {
  const call = async (fn, args) => {
    try { return await rpc(fn, { p_key: key, ...args }); }
    catch (err) { if (err.invalidLink) onInvalidLink(key); throw err; }
  };
  return {
    key,
    load: () => call('fi_load'),
    setRank: (item, rank) => call('fi_set_rank', { p_item: item, p_rank: rank }),
    editItem: (item, field, value, expected) => call('fi_edit_item', { p_item: item, p_field: field, p_value: value, p_expected: expected }),
    history: (item) => call('fi_item_history', { p_item: item }),
    adminPeople: () => call('fi_admin_people'),
    adminNewLink: (person) => call('fi_admin_new_link', { p_person: person }),
    adminTurnOffLink: (person) => call('fi_admin_turn_off_link', { p_person: person }),
    adminSetHidden: (item, hidden) => call('fi_admin_set_hidden', { p_item: item, p_hidden: hidden }),
    adminSetEditor: (person, editor) => call('fi_admin_set_editor', { p_person: person, p_editor: editor }),
    draftDone: (item, status) => call('fi_draft_done', { p_item: item, p_status: status }),
  };
}
