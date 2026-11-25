# Links and admin

## How personal links work

- A link looks like `https://pockelmann1.github.io/family-inventory/?k=<key>`.
  The key is 40 letters and digits. Older links use `#k=` and a 32 or 43
  character key; they keep working.
- Only a SHA-256 hash of the key is stored, so nobody (not even the admin) can
  look a key up later. A new key is shown **once**, when it is made.
- Each person has one working key. Making a new one turns the old one off on
  every device.
- After someone opens their link, the key stays in the address bar and in the
  browser's storage, so the site keeps working from bookmarks, Home Screen
  icons and in-app browsers.
- If a link opens that belongs to someone else on a device that is already
  signed in, the site asks "Who is ranking?" before switching.
- An old or cut-off link never signs out a working sign-in on that device.
- Anyone signed in can see their name at the top ("Ranking as …") and can sign
  out of that device from the footer.

## Admin page (`#/admin`, admin link only)

- **Make link / New link.** Shows a panel with the new link and buttons to
  copy it, share it, or open a ready-made text message or email. The message
  puts the link alone on its last line, because some phones cut off a link
  that has text right after it. Send it straight away: the panel is the only
  place the key is ever shown.
- **Turn off.** That person's link stops working at once; an open tab signs
  out on its next action.
- Who can do what comes from each person's role: the four siblings (and the
  admin) can edit item details and adjust their own family's ranks; children
  rank and keep a top 10. There is nothing to switch on per person.
- **Removed items** (bottom of the page) lists items taken off the website,
  with who removed them and when, and **Restore** for each.
- The summary line shows how many family members have a link, have opened it
  and have started ranking.

### Before making someone a new link

If someone says the site shows "Welcome", first ask them to tap the link in
the newest message again. A new link signs them out on every other device, so
only make one if the old link is lost or was shared.

## Assigning items (`#/assign`, admin link only)

- **Close ranking** first (tap twice). Families can no longer change ranks or
  top 10s. "Reopen ranking" is there until the first push.
- Each row shows every family's best rank and a "Why" line: who ranked it best,
  ties, and where it sits in each family top 10. Tap a family to give it the
  item; tap it again to take that back. "Confirm" accepts the suggestion.
- Filters: Needs a decision, Ties, Wanted by 2+ families, In someone's top 10,
  Nobody ranked, Confirmed, and (after a push) Changed since push.
- **Push to families** unlocks when every item has a family. After that, any
  change shows "N changes not yet pushed" with Show changes, Discard and
  **Push update**. Families only ever see the last push.
- Results' CSV download includes the draft family and the pushed family.

## Removing an item

Open the item and use **Remove from website** in the Admin section (tap
twice). The item disappears for everyone, the admin included: Browse, My
family, Results, Assign, top 10s and the CSV. It stays in the database
(`items.hidden = true`) with its ranks and history. Put it back from Admin →
Removed items → **Restore**. Both steps are recorded in the item's edit
history.

## Downloading photos

Browse → **Download all photos** (or **Download photos of these N** after a
search or filter, for example Type: Ceramics). Everyone has it. It saves one
zip file of the website-size photos (1024 pixels on the long side, about
0.1 MB each), named like `ITEM-0001 <item name>.jpg`; items with more than
one photo get `- photo 2` and so on. The full-resolution originals stay in
Google Drive.

## Downloading everything

Results → **Download everything as a spreadsheet (CSV)** (admin only). It has
every item, every person's rank, each family's best and the top interest.
Values that start like a spreadsheet formula are prefixed with `'` so Excel and
Google Sheets show them as text.
