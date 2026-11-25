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
| `top_picks` | place in someone's top 10 | `person_id`, `item_id`, `pos` 1 to 10. An item can be in a person's list once, and only if they ranked it. Clearing the rank takes it out and closes the gap |
| `stage` | (one row) | `ranking_open`, `closed_at`, `pushed_at`, `push_count`: where the family is in ranking and assignment |
| `assignments` | item given to a family (admin's working copy) | `family_id`, who decided and when. Families never see this table directly |
| `assignments_pushed` | item given to a family, as families see it | copied from `assignments` each time the admin pushes |
| `item_edits` | change to an item | who, when, field, old and new value. Shown as "Edit history"; a change to `hidden` means the item was removed or restored |
| `family_ranks` | a sibling's adjustment of their family's rank for an item | `family_id`, `item_id`, `rank` 1 to 5, `set_by`, `set_at`. No row means automatic |
| `item_drafts` | suggestion for an item | name, type, subtype, description written from the photo; `status` open, used or dismissed |
| `import_tokens` | import token | hashed; `active = false` once an import is finished |
| `photo_staging` | photo waiting to be moved into storage | emptied by the daily photo job |

The view `app.item_results` works out each family's rank (the lowest number
anyone in the family gave, unless `family_ranks` has a row for it), the overall
best, and which families tie for the top interest. Assign and Results use it.

`items.hidden` means **removed from the website**: no screen shows it, the
admin's included, but the row, its ranks and its history stay.

People with role `sibling` (and the admin) may edit item details and family
ranks; `app.editor_for` checks this. The old `people.is_editor` column is no
longer used. The admin's person row is named "Admin".

## Functions the website calls

Every function takes the caller's link key first and checks it before doing
anything. "Who" says which check it runs.

| Function | Who | What it does |
| --- | --- | --- |
| `fi_load(key)` | anyone with a link | Everything for the screens. Removed (hidden) items are left out for everyone; Drive links only for admin; drafts only for siblings and admin. `is_editor` is true for the admin and siblings. Each item has `family_set`: family ranks a sibling adjusted, as `{family_id: {rank, by, at, auto}}` (own family; every family for the admin). Family members get only their own family's ranks and family rank (no overall best or most-wanted families); the admin gets everything. Also returns `stage` (ranking open or closed, when it was pushed), each item's `went_to` family once assignments are pushed (everyone), and the admin's draft `assigned` family (admin only). Also returns `top10`: each person's list, for the caller's own family (everyone for the admin). Updates `last_seen_at`. |
| `fi_set_rank(key, item, rank)` | family members | Refused once ranking is closed. Sets 1 to 5, or clears with `null`. Returns the item's new ranks, family rank and `family_set` for the caller's own family only. |
| `fi_set_family_rank(key, item, rank)` | siblings | Refused once ranking is closed, and for children. Sets the caller's family's rank for an item (1 to 5), or `null` to go back to automatic. Individual ranks are not touched. Returns the same as `fi_set_rank`. |
| `fi_set_top10(key, items)` | family members | Refused once ranking is closed. Saves the caller's whole top 10 as an ordered list of item IDs (up to 10, no repeats, each one ranked by the caller). Returns the saved list. |
| `fi_edit_item(key, item, field, value, expected)` | siblings and admin | Edits name, type, subtype, origin or description, and logs it. If `expected` no longer matches (someone else saved first) it saves nothing and returns `conflict: true` with the current value. |
| `fi_item_history(key, item)` | anyone with a link | Edit history, newest first. The website's Restore calls `fi_edit_item` with the earlier value. |
| `fi_draft_done(key, item, status)` | siblings, admin | Marks a suggestion `used` or `dismissed`. |
| `fi_admin_set_ranking(key, open)` | admin | Closes ranking (`false`) or reopens it (`true`). Cannot reopen after the first push. |
| `fi_admin_assign(key, item, family)` | admin | Only while ranking is closed. Gives an item to a family in the working copy, or `null` to take the decision back. Families see nothing until a push. |
| `fi_admin_push(key)` | admin | Copies the working copy to what families see. Refused while ranking is open or while any visible item has no family. Used for the first push and every "Push update". |
| `fi_admin_discard_assignments(key)` | admin | Puts the working copy back to the last push. |
| `fi_admin_people(key)` | admin | Everyone, with link status and rank counts. |
| `fi_admin_new_link(key, person)` | admin | Makes a new key for a person and returns it once. Their old link stops working. |
| `fi_admin_turn_off_link(key, person)` | admin | Turns a person's link off. |
| `fi_admin_set_hidden(key, item, hidden)` | admin | Removes an item from the website (`true`) or restores it (`false`). Logged in the edit history. |
| `fi_admin_removed_items(key)` | admin | Removed items with a thumbnail, and who removed them and when. |
| `fi_admin_set_editor(key, person, editor)` | admin | No longer used by the website (editing comes from the sibling role). |
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
