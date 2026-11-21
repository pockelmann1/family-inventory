// Talks to the Supabase database. The publishable key below is public by
// design: it can only call the fi_* functions, and each of those checks the
// caller's personal link key before doing anything.
const SUPABASE_URL = 'https://joclsntnnmtzzeippxhp.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_l1slwkNY7ofygcwQWt4QrA_-FazT4jv';

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
    this.invalidLink = /invalid link/i.test(message);
  }
}

async function rpc(fn, args) {
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.', 0);
  }
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(body?.message || `Request failed (${res.status})`, res.status);
  return body;
}

export function makeApi(key) {
  return {
    load: () => rpc('fi_load', { p_key: key }),
    setRank: (item, rank) => rpc('fi_set_rank', { p_key: key, p_item: item, p_rank: rank }),
    editItem: (item, field, value) => rpc('fi_edit_item', { p_key: key, p_item: item, p_field: field, p_value: value }),
    history: (item) => rpc('fi_item_history', { p_key: key, p_item: item }),
    adminPeople: () => rpc('fi_admin_people', { p_key: key }),
    adminNewLink: (person) => rpc('fi_admin_new_link', { p_key: key, p_person: person }),
    adminTurnOffLink: (person) => rpc('fi_admin_turn_off_link', { p_key: key, p_person: person }),
    adminSetHidden: (item, hidden) => rpc('fi_admin_set_hidden', { p_key: key, p_item: item, p_hidden: hidden }),
  };
}
