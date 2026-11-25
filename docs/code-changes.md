# Code changes

## Run the site on your computer

Needs Node.js 22 (or 20+).

```sh
npm install
npm run dev
```

Open the address it prints, then add your link key: `http://localhost:5173/family-inventory/?k=<your key>`.
**This uses the live database**: ranks and edits you make are real. For
anything risky, use a private copy (next section).

`npm run build` makes the production files in `dist/`; `npm run preview`
serves them.

## Test against a private copy of the database

Use this for schema changes and anything that writes data.

1. Install PostgreSQL 15 or 16 locally and start it.
2. Create the Supabase roles the schema expects, then apply the schema:

   ```sql
   create role anon nologin; create role authenticated nologin;
   create schema if not exists extensions;
   ```
   ```sh
   psql -d postgres -f supabase/schema.sql
   ```
3. Load test data. Never copy real family data into the repository; keep test
   data in a scratch folder. The import functions (`fi_import`,
   `fi_stage_photo`) accept the payload format described in `schema.sql` with an
   import token you add locally:

   ```sql
   insert into app.import_tokens (token_hash) values (app.key_hash('local-test-token-xxxxxxxxxxxx'));
   ```
4. Point the browser at the copy. The simplest way is a test script (for
   example with Playwright) that intercepts requests to
   `https://<project>.supabase.co/rest/v1/rpc/<function>` and runs
   `select public.<function>(...)` as role `anon` against the local database.
   That exercises exactly the same permission checks as the live API.
5. Check at phone width (390 px) and desktop width, and look for sideways
   scrolling.

## Deploy

1. Work on a branch and open a pull request. The **Check** job builds it.
2. Merge to `main`. Then, automatically:
   - **Deploy site** publishes the new site (about a minute).
   - **Database setup** runs if `supabase/schema.sql` changed.
   - **Photos and keep-alive** runs if its script changed.
3. Watch the Actions tab until all are green. Hard-refresh the site.

Database and photo jobs only run from `main`, so a branch can never change the
live database.

## Roll back

- **Website:** GitHub → the merged pull request → **Revert** → merge the revert.
  Deploy runs again with the old code.
- **Database:** `schema.sql` changes are additive, so reverting the file does
  not undo them. Write a small follow-up change that puts things back (for
  example re-create the old version of a function), and merge it.
- **Data:** every item edit is in `app.item_edits` with the old value, so a
  bad edit can be put back by hand. Ranks are not versioned; Supabase's free
  plan has no point-in-time restore, so download the CSV from Results now and
  then as a backup.

## Code map

| File | What is in it |
| --- | --- |
| `src/main.js` | Sign-in (`keyFromUrl`, `start`), shared state, and one `render…` function per screen: Browse (with the Edit info panel and photo download), Item, My family, Results, Assign, Admin. `src/zip.js` writes the photo zip. Rank clicks are handled once for the whole page. |
| `src/api.js` | `makeApi(key)`: one method per `fi_*` function, 20-second timeout, plain-language errors, sign-out on an invalid link. |
| `src/style.css` | Colors and sizes at the top (`:root`), then one section per screen. |
| `index.html` | Page shell, security headers (no referrer, no indexing, content security policy). |
| `public/404.html` | Rescues links whose `#` was rewritten as `%23` by email apps. |
