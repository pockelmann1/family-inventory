// Moves staged photos into the private "photos" storage bucket and refreshes
// the time-limited signed URLs the site shows.
//
// Runs in GitHub Actions only. Needs:
//   SUPABASE_URL, SUPABASE_SECRET_KEY  (storage API, secret key from repo secrets)
//   PGHOST/PGUSER/PGPASSWORD/...       (set by scripts/pg-env.sh)
// Prints counts only, never family data, because Action logs on a public
// repository are public.

import pg from 'pg';

const BUCKET = 'photos';
// Signed URLs last 3 days and are renewed daily, so a photo link copied out
// of the site (or kept by someone whose link was turned off) dies quickly,
// while one missed daily run still leaves a day of slack.
const SIGN_SECONDS = 3 * 24 * 3600;
const REFRESH_WITHIN = '50 hours'; // re-sign anything expiring sooner than this

const base = process.env.SUPABASE_URL.replace(/\/$/, '');
const key = process.env.SUPABASE_SECRET_KEY;
if (!key) throw new Error('SUPABASE_SECRET_KEY secret is missing');

const headers = { apikey: key };
if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // legacy service_role JWT

async function storage(path, init = {}) {
  const res = await fetch(`${base}/storage/v1${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { ok: res.ok, status: res.status, body };
}

async function ensureBucket() {
  const got = await storage(`/bucket/${BUCKET}`);
  if (got.ok) {
    if (got.body.public) throw new Error('The photos bucket is public; it must be private.');
    return;
  }
  const made = await storage('/bucket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: BUCKET, name: BUCKET, public: false,
      file_size_limit: 10 * 1024 * 1024, allowed_mime_types: ['image/jpeg'],
    }),
  });
  if (!made.ok) throw new Error(`Could not create bucket (${made.status})`);
  console.log('Created private bucket');
}

async function upload(path, bytes) {
  const res = await storage(`/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000' },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
}

async function moveStaged(db) {
  const { rows } = await db.query(
    'select s.drive_id, p.id as photo_id from app.photo_staging s join app.photos p on p.original_drive_id = s.drive_id order by s.staged_at');
  let moved = 0;
  for (const r of rows) {
    const { rows: [blob] } = await db.query(
      'select full_jpg, thumb_jpg, width, height from app.photo_staging where drive_id = $1', [r.drive_id]);
    const full = `${r.photo_id}/full.jpg`;
    const thumb = `${r.photo_id}/thumb.jpg`;
    await upload(full, blob.full_jpg);
    await upload(thumb, blob.thumb_jpg);
    await db.query(
      `update app.photos set storage_path = $2, thumb_path = $3, width = $4, height = $5,
              full_url = null, thumb_url = null, urls_expire_at = null where id = $1`,
      [r.photo_id, full, thumb, blob.width, blob.height]);
    await db.query('delete from app.photo_staging where drive_id = $1', [r.drive_id]);
    moved++;
  }
  console.log(`Moved ${moved} staged photo(s) into private storage`);
}

async function refreshSignedUrls(db) {
  const { rows } = await db.query(
    `select id, storage_path, thumb_path from app.photos
      where storage_path is not null
        and (urls_expire_at is null or urls_expire_at < now() + interval '${REFRESH_WITHIN}')`);
  let signed = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const paths = batch.flatMap((r) => [r.storage_path, r.thumb_path]);
    const res = await storage(`/object/sign/${BUCKET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: SIGN_SECONDS, paths }),
    });
    if (!res.ok) throw new Error(`Signing failed (${res.status})`);
    const byPath = new Map(res.body.filter((x) => x.signedURL).map((x) => [x.path, `${base}/storage/v1${x.signedURL}`]));
    for (const r of batch) {
      const full = byPath.get(r.storage_path);
      const thumb = byPath.get(r.thumb_path);
      if (!full || !thumb) continue;
      await db.query(
        `update app.photos set full_url = $2, thumb_url = $3,
                urls_expire_at = now() + make_interval(secs => $4) where id = $1`,
        [r.id, full, thumb, SIGN_SECONDS]);
      signed++;
    }
  }
  console.log(`Refreshed signed links for ${signed} photo(s)`);
}

const db = new pg.Client({ ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  await ensureBucket();
  await moveStaged(db);
  await refreshSignedUrls(db);
} finally {
  await db.end();
}
