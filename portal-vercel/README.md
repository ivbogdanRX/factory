# Ad Factory — glance portal (Vercel)

Read-only mobile dashboard. The Mac orchestrator pushes a status snapshot here
every minute; this app stores it in Vercel Blob and serves the glance page.
No inbound access to the Mac is needed. Controls stay in Slack (`/adops`).

## Deploy (one time, ~5 min)

```bash
cd portal-vercel
npx vercel login          # if not logged in
npx vercel --prod         # creates + deploys the project
```

Then in the Vercel dashboard for the project:

1. **Storage → Create Database → Blob** → connect it to the project
   (this injects `BLOB_READ_WRITE_TOKEN` automatically).
2. **Settings → Environment Variables**, add:
   - `PUSH_SECRET` — any long random string (e.g. `openssl rand -hex 24`)
   - `VIEW_SECRET` — optional but recommended; a key you'll type once on your
     phone to view the dashboard (spend data is in the snapshots)
3. Redeploy (`npx vercel --prod` again) so the env vars take effect.

## Point the Mac at it

In `ad-factory/.env`:

```
PORTAL_PUSH_URL=https://<your-app>.vercel.app/api/push
PORTAL_PUSH_SECRET=<same value as PUSH_SECRET>
```

Restart the orchestrator (`launchctl kickstart -k gui/$UID/com.adfactory.orchestrator`).
Within a minute the dashboard at `https://<your-app>.vercel.app` goes live.
Add it to your phone's home screen for the app feel.

## Notes

- `public/` is also served locally by the orchestrator at
  `http://localhost:5180/` — same page, live data, no push needed.
- If the Mac stops pushing, the page shows "snapshot is stale".
