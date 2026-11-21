# Everyday edits without code

Most changes need no code at all. The first two are done on the website; the
rest are done in the Supabase dashboard's **SQL Editor** (Dashboard → your
project → SQL Editor → New query → paste → Run). Nothing here touches GitHub.

## Fix or add an item's details (website)

- **One item:** open it and tap **Edit** next to Name, Type, Subtype, Origin or
  Description. Type is a pick list; choose **Add a new type…** to create one.
  Subtype is a pick list of the subtypes already used with that type, plus
  **Add a new subtype…**.
  Every change is kept in the item's edit history.
- **Many items:** editors and the admin have **Add info** in the menu. It shows
  one item at a time with a big photo and every field. Filter by what is
  missing ("Needs a name", "Has a suggestion", a room…), then **Save and next**
  or **Skip**.
- **Suggestions:** items marked "suggested" were pre-filled from the photo.
  Nothing is saved until someone taps Save; **Suggestion is wrong, discard it**
  throws it away.
- If two people edit the same field at once, the second one is warned and sees
  the newer text before deciding.

## Give someone the Add info screen (website)

Admin → find the person → **Can add info**. Tap again to remove it.

## Hide an item instead of deleting it (website)

Open the item → **Hide this item** (admin only). This keeps its ranks and
history and can be undone. Prefer it to deleting.

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
