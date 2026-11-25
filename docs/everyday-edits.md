# Everyday edits without code

Most changes need no code at all. The first two are done on the website; the
rest are done in the Supabase dashboard's **SQL Editor** (Dashboard → your
project → SQL Editor → New query → paste → Run). Nothing here touches GitHub.

## Fix or add an item's details (website)

The admin and the four siblings can do this; children see the details
without an Edit info button. The database refuses edits from anyone else.

- In Browse, tap **Edit info** under any item (or **Edit info** on the item's
  own page). A panel opens with the photo and every field: Name, Type,
  Subtype, Origin, Description. Type is a pick list; choose **Add a new type…**
  to create one. Subtype is a pick list of the subtypes already used with that
  type, plus **Add a new subtype…**. **Save** saves only the fields that
  changed.
- Every change is kept in the item's **Edit history** (on the item page, open
  to everyone). The admin and the siblings get **Restore** next to each earlier
  value; restoring is itself a change, so it shows in the history too.
- If two people edit the same field at once, the second one is warned and sees
  the newer text before deciding.

## Adjust a family rank (website)

A family's rank for an item starts as the lowest number anyone in that family
gave. The family's sibling can change it while ranking is open: on the item
page (under "Your family") or by tapping the family rank on My family. It then
shows "Set by …" and **Reset to automatic** puts it back. Everyone's own ranks
are never changed, and Assign uses the family rank.

## Remove an item instead of deleting it (website)

Open the item → **Remove from website** (admin only, tap twice). It disappears
for everyone, the admin included, but stays in the database with its ranks and
history. Admin → **Removed items** lists them, each with **Restore**. Prefer it
to deleting.

## Add a new item (SQL)

Pick the next free ID (the highest is shown at the end of Browse in catalog
order).

```sql
insert into app.items (id, name, room, photo_no, type, sort)
values ('ITEM-0290', 'Brass lamp', 'Living Room', '', 'Lighting', 290);
```

It appears for everyone on their next page load. Add a photo as below.

## Add or replace a photo (Dashboard + SQL)

1. Make two JPEGs from the photo: a full one about 1024 px on the long side,
   and a thumbnail about 720 px wide. Remove location data (most phone "export"
   or "save as" options do; on a Mac, Preview → Tools → Show Inspector → GPS →
   Remove Location Info).
2. In SQL Editor, create the photo record and note the id it returns:

   ```sql
   insert into app.photos (storage_path, thumb_path)
   values ('PLACEHOLDER', 'PLACEHOLDER') returning id;
   ```
3. Dashboard → Storage → bucket **photos** → create folder named with that id
   → upload the two files as `full.jpg` and `thumb.jpg`.
4. Point the record at the files and attach it to the item (put the id in
   both places):

   ```sql
   update app.photos
      set storage_path = '<id>/full.jpg', thumb_path = '<id>/thumb.jpg', urls_expire_at = null
    where id = '<id>';
   insert into app.item_photos (item_id, photo_id, sort_order)
   values ('ITEM-0290', '<id>', 0);
   ```
5. GitHub → Actions → **Photos and keep-alive** → Run workflow. It signs the new
   photo's links (or wait for the daily run).

To replace a photo, upload new files over the old `full.jpg` and `thumb.jpg`
in the same folder, then run the same workflow.

## Remove an item for good (SQL)

Hiding is usually better. If it must go (for example a duplicate):

```sql
delete from app.items where id = 'ITEM-0290';
```

Its ranks, photo links and history are removed with it. The photo files stay in
storage; delete the folder in Storage if you want them gone.

## Add a family member (SQL + website)

```sql
insert into app.people (family_id, name, role, sort)
select id, 'New Person', 'child', 9 from app.families where name = 'FamilyName';
```

`role` is `sibling` or `child`. Then Admin → **Make link** for them.

## Change someone's family or name (SQL)

```sql
update app.people set name = 'New Name' where name = 'Old Name';
```

## Do not re-run the original import

`fi_import` would overwrite every item's name and details with the values from
the original spreadsheet, and could switch old links back on. Its token is
switched off; leave it that way.
