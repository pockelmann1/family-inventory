# Family Inventory handover guide

Everything someone new needs to run, change or fix this site. Start with
**How it fits together**, then jump to the guide for the job at hand.

| Guide | Read it when you want to… |
| --- | --- |
| [How it fits together](architecture.md) | understand the parts and how a page load works |
| [Database](database.md) | look up a table or function, or change the schema safely |
| [Links and admin](links-and-admin.md) | make, send or turn off someone's link, remove and restore items, download photos |
| [Everyday edits without code](everyday-edits.md) | fix item details, add or remove an item or photo, add a person |
| [Code changes](code-changes.md) | run the site on a computer, test, deploy or roll back |
| [Secrets and accounts](secrets-and-accounts.md) | find out what accounts and keys exist and how to rotate them |
| [Troubleshooting](troubleshooting.md) | someone sees "Welcome", photos are broken, a job failed |

## The ten-second version

- The code is public on GitHub. **No family data lives in this repository**: no
  names of items, no ranks, no photos, no keys. Keep it that way.
- The data lives in a free Supabase project: a Postgres database and a private
  photo bucket.
- The website is plain HTML, CSS and JavaScript built with Vite and served by
  GitHub Pages. Every push to `main` redeploys it.
- People sign in with a personal link (`…/family-inventory/?k=<key>`). The
  database stores only a hash of each key.
- Three GitHub Actions do the housekeeping: apply the database schema, refresh
  photo links daily, and deploy the site.
