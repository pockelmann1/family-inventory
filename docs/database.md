# Database

Everything is defined in [`supabase/schema.sql`](../supabase/schema.sql). The
file is written to be **safe to run again and again**: tables use
`create … if not exists`, columns use `add column if not exists`, and functions
use `create or replace`. It holds no family data.

## Tables (schema `app`)

| Table | One row per | Notes |
| --- | --- | --- |
| `families` | sibling family | `name`, `sort` (display order) |
| `people` | person | `family_id` (empty for the admin), `role` (sibling, child, admin), `is_admin`, `is_editor`, `link_key_hash` (SHA-256 of their link key; empty means no working link), `last_seen_at` |
| `items` | item in the house | `id` like `ITEM-0001`, `name`, `room`, `photo_no`, `type`, `subtype`, `origin`, `description`, `hidden`, `sort` |
| `photos` | photo | `original_drive_id`, `storage_path`/`thumb_path` in the bucket, signed `full_url`/`thumb_url` and when they expire |
| `item_photos` | photo shown on an item | an item can have several photos, in `sort_order` |
| `rankings` | person's rank of an item | `rank` 1 to 5; deleting the row clears the rank |
| `item_edits` | change to an item | who, when, field, old and new value. Shown as "Edit history" |
| `item_drafts` | suggestion for an item | name, type, subtype, description written from the photo; `status` open, used or dismissed |
| `import_tokens` | import token | hashed; `active = false` once an import is finished |
| `photo_staging` | photo waiting to be moved into storage | emptied by the daily photo job |

The view `app.item_results` works out each family's best (lowest) rank, the
overall best, and which families tie for the top interest.

## Functions the website calls

Every function takes the caller's link key first and checks it before doing
anything. "Who" says which check it runs.

| Function | Who | What it does |
| --- | --- | --- |
| `fi_load(key)` | anyone with a link | Everything for the screens. Hidden items only for admin; Drive links only for admin; drafts only for editors and admin. Family members get only their own family's ranks and family best (no overall best or most-wanted families); the admin gets everything. Updates `last_seen_at`. |
| `fi_set_rank(key, item, rank)` | family members | Sets 1 to 5, or clears with `null`. Returns the item's new ranks and family best for the caller's own family only. |
| `fi_edit_item(key, item, field, value, expected)` | editors and admin | Edits name, type, subtype, origin or description, and logs it. If `expected` no longer matches (someone else saved first) it saves nothing and returns `conflict: true` with the current value. |
| `fi_item_history(key, item)` | anyone with a link | Edit history, newest first. |
| `fi_draft_done(key, item, status)` | editors, admin | Marks a suggestion `used` or `dismissed`. |
| `fi_admin_people(key)` | admin | Everyone, with link status and rank counts. |
| `fi_admin_new_link(key, person)` | admin | Makes a new key for a person and returns it once. Their old link stops working. |
| `fi_admin_turn_off_link(key, person)` | admin | Turns a person's link off. |
| `fi_admin_set_hidden(key, item, hidden)` | admin | Hides or shows an item for family members. |
| `fi_admin_set_editor(key, person, editor)` | admin | Gives or removes the Add info screen. |
| `fi_admin_add_drafts(key, drafts)` | admin | Loads suggestions (JSON list of `{id, name, type, subtype, description}`). Leaves used or dismissed ones alone. |
| `fi_ping()` | anyone | Returns 1. The daily job calls it so the free project never pauses. |
| `fi_import`, `fi_stage_photo`, `fi_import_status`, `fi_import_finish` | import token | The original bulk import. The token is switched off. See [Everyday edits](everyday-edits.md) before using them again. |

## Changing the schema safely

1. Edit `supabase/schema.sql` on a branch. Keep it re-runnable: `if not exists`,
   `add column if not exists`, `create or replace`.
2. **Changing a function's arguments** creates a second version next to the
   old one. Add `drop function if exists public.fi_x(old argument types);`
   right before the new `create or replace`, as `fi_edit_item` does.
3. **New tables** must be added to both lists in the two `do $$ … $$` blocks
   near the top, so row-level security and the owner policy are applied.
4. New `fi_*` functions are granted to the website automatically by the grants
   block at the end. Start each one with `app.person_for`, `app.admin_for` or
   `app.editor_for`, mark it `security definer set search_path = ''`, and write
   every table name as `app.<table>`.
5. Test it on a copy first (see [Code changes](code-changes.md)).
6. Merge to `main`. The **Database setup** job applies it to the live project.
   It fails loudly on any SQL error; check the run in the Actions tab.

You can also run the file by hand in the Supabase SQL editor (Dashboard → SQL
Editor → paste the file → Run). It is the same thing the job does.
