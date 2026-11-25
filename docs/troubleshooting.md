# Troubleshooting

## Someone sees "Welcome" instead of the collection

1. Ask them to tap the link in the **newest** message from the admin again.
   That fixes nearly every case (a new browser, a cleared browser, opening it
   from a different app).
2. If the page says **"This link has been turned off or replaced"** or **"This
   link did not work"**, check Admin: is their link on? Has someone made them a
   new one? Send the newest link, or make one.
3. If it says **"This link looks cut off"**, their message app broke the link.
   Copy the link again and send it on its own line.
4. Only make a new link as a last resort: it signs them out everywhere else.

## The page says "Loading" for a long time or shows an error

- "The connection is too slow" or "Could not reach the server": the phone has
  a weak signal or is offline. Try again on Wi-Fi.
- "The connection returned an unexpected page": they are on hotel or airport
  Wi-Fi that wants them to sign in first.
- Everyone sees errors at once: the Supabase project may be paused. Supabase →
  the project → **Restore**. Then check the **Photos and keep-alive** job, whose
  daily ping is meant to prevent this.

## Photos are broken or gray

Signed photo links last 3 days and are renewed every day by **Photos and
keep-alive**.

1. GitHub → Actions → **Photos and keep-alive**. Is the latest run green and
   recent? If not, open it to see which step failed, then **Run workflow**.
2. If the job is missing from the schedule, GitHub may have switched it off
   after 60 days without repository changes (the job tries to prevent this).
   Actions → the workflow → **Enable workflow**, then **Run workflow**.
3. After a successful run, people need to reload the page.

## A GitHub job failed

- **Database setup:** open the run. A SQL error names the line in
  `supabase/schema.sql`. Fix it on a branch and merge again. Nothing after the
  error was applied.
- **Photos and keep-alive:**
  - "SUPABASE_SECRET_KEY secret is missing", "Could not create bucket" or
    "Signing failed (401)": the secret key was removed or rotated; see
    [Secrets and accounts](secrets-and-accounts.md).
  - "Could not connect to the Supabase database": Supabase may be paused, or
    the database password changed.
- **Deploy site:** usually a build error from the last change. The previous
  version stays online until a deploy succeeds.

## A rank or edit "didn't save"

- A message on screen says why. Rank buttons come back after a failed save and
  the old rank is kept.
- Edits are in the item's **Edit history**. If someone's text was replaced,
  the old text is there and can be put back.
- Removed items cannot be ranked or edited by anyone until the admin restores
  them (Admin → Removed items).
- Only siblings and the admin can edit item details or family ranks; children
  get a message saying so.

## Someone ranked as the wrong person

This happens when two people share a phone or tablet. The site asks "Who is
ranking?" when a second person's link opens, and shows "Ranking as …" at the
top. To fix past ranks, the right person re-ranks the items, and the wrong
person clears theirs (Clear my rank) on the item page.

## The site looks out of date after a change

Deploys take about a minute. Then close and reopen the tab, or pull down to
refresh on a phone.
