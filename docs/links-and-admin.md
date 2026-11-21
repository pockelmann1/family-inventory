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
- **Can add info.** Gives that person the Add info screen and lets them see
  and accept suggestions. The admin always has it.
- The summary line shows how many family members have a link, have opened it
  and have started ranking.

### Before making someone a new link

If someone says the site shows "Welcome", first ask them to tap the link in
the newest message again. A new link signs them out on every other device, so
only make one if the old link is lost or was shared.

## Hiding an item

Open the item and use **Hide this item** in the Admin section. Hidden items
disappear for everyone except the admin (they are still in the CSV download,
marked "yes" under Hidden). Ranks on a hidden item are kept, and the item can
be shown again with the same button. The change is recorded in the item's edit
history.

## Downloading everything

Results → **Download everything as a spreadsheet (CSV)** (admin only). It has
every item, every person's rank, each family's best and the top interest.
Values that start like a spreadsheet formula are prefixed with `'` so Excel and
Google Sheets show them as text.
