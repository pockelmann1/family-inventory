# Secrets and accounts

Names and places only. **Never paste a secret value into an issue, a pull
request, a chat or this repository.** GitHub Action logs on a public repository
are public too, so scripts print counts only.

## Accounts

| Account | Used for | Who controls it |
| --- | --- | --- |
| GitHub `pockelmann1` | This repository, GitHub Pages hosting, the Actions jobs | the repository owner |
| Supabase project `family-inventory` (ref `joclsntnnmtzzeippxhp`, free plan) | Database and private photo storage | the Supabase account owner |
| Google Drive folder of house photos | The original full-size photos | the folder's owner |

## Keys and where they live

| Name | Secret? | Where it lives | What it can do |
| --- | --- | --- | --- |
| Supabase publishable key (`sb_publishable_…`) | No, public by design | `src/api.js`, `photos.yml` | Call the `fi_*` functions only; each one still needs a link key |
| `SUPABASE_SECRET_KEY` | **Yes** | GitHub → Settings → Secrets and variables → Actions | Full access to storage (used to move photos and sign links) |
| `SUPABASE_DB_PASSWORD` | **Yes** | same place | Full access to the database (used to apply the schema and by the photo job) |
| Personal link keys | **Yes, per person** | Nowhere: only their SHA-256 hash is in `app.people` | Sign in as that person |
| Import token | Yes | Only its hash in `schema.sql`; switched off | Bulk import (unused now) |

## Rotating a secret

- **Database password:** Supabase → Project Settings → Database → Reset
  database password. Then update `SUPABASE_DB_PASSWORD` in GitHub and re-run
  **Database setup** and **Photos and keep-alive** to check.
- **Secret key:** Supabase → Project Settings → API Keys → create a new secret
  key, update `SUPABASE_SECRET_KEY` in GitHub, re-run **Photos and keep-alive**,
  then delete the old key in Supabase.
- **A person's link:** Admin page → **New link** (turns the old one off).
- **The admin's own link:** Admin page → New link on your own row. The new
  link is shown once; save it before leaving the page.

## Supabase settings that should stay as they are

- Data API on, with **no** "expose new tables automatically".
- Row-level security on for new tables.
- Authentication: email sign-ups **off** (the site does not use Supabase
  accounts). Authentication → Sign In / Providers → turn off "Allow new users to
  sign up" and the Email provider.
- Storage bucket `photos` **private**.

## Things that share the browser's storage

Every GitHub Pages site under `pockelmann1.github.io` shares one browser
origin. Don't publish other Pages sites from this account (or use a custom
domain for them), so no other site could read this one's stored key.
