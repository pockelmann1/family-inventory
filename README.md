# Family Inventory

A website where family members mark which items from the house they would like,
ranking each from 1 (most wanted) to 5.

Live at <https://pockelmann1.github.io/family-inventory/>. Each person signs in with
their own private link; without one the site shows only a welcome page.

**Handover guide:** [docs/](docs/README.md) explains how everything fits
together, the database, links and admin, everyday edits without code, code
changes and deploys, secrets, and troubleshooting.

## How it fits together

- **This repository holds code only.** No family data, names or photos live here.
- **Supabase** (free tier) holds people, items, ranks and photos. All tables sit in a
  private `app` schema with row-level security on. The browser can only call the
  `fi_*` functions in `supabase/schema.sql`, and each checks the caller's link key.
- **Photos** sit in a private storage bucket. The site shows them through signed links
  that expire after 3 days and are refreshed daily.
- **Personal links** look like `…/family-inventory/?k=<key>` (older `#k=` links still
  work). Only a SHA-256 hash of each key is stored. The admin page makes a new link
  for anyone, which turns off their old one.

## GitHub Actions

| Workflow | What it does | Runs |
| --- | --- | --- |
| Database setup | Applies `supabase/schema.sql` (safe to re-run) | When the schema changes on `main`, or by hand |
| Photos and keep-alive | Moves newly uploaded photos into private storage, refreshes signed photo links, and pings Supabase so the free project doesn't pause | Daily, or by hand |
| Deploy site | Builds the site and publishes it to GitHub Pages | On every push to `main` |
| Check | Builds the site to catch errors | On pull requests |

Repository secrets used: `SUPABASE_DB_PASSWORD` and `SUPABASE_SECRET_KEY`. Action logs
on a public repository are public, so the scripts print counts only.

## Local development

```sh
npm install
npm run dev
```
