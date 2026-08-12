# Meta Ads Uploader

A browser-based tool for bulk-uploading videos and images to Meta Ads. Drop in a batch of
creatives, tag them with a consistent naming taxonomy, and push them to an ad account —
either straight into the media library or wired up as live ads.

Built with React 18, TypeScript and Vite. Talks directly to the Meta Graph API (v21.0)
from the browser.

## Features

**Three upload modes**

| Mode | What it does |
| --- | --- |
| **Media Library** | Uploads creatives to the ad account's media library only. No ads created. |
| **Create Ads** | Uploads and builds ads — into a new campaign/ad set, or an existing one. |
| **Copy Campaign** | Clones an existing campaign's structure and settings to a destination account. |

**Creative tagging** — Tag files by Audience, Style and Hook/Angle from a persisted
taxonomy, plus up to 4 custom fields you define. Tags are composed into the uploaded
filename so naming stays consistent across batches.

**AI creative analysis** — Optional Gemini integration inspects each image or video and
suggests tags automatically, so large batches don't have to be tagged by hand.

**Duplicate detection** — Before uploading, the app checks the destination account's
existing video library and skips creatives that are already there.

**Ad settings cloning** — When creating a new campaign or ad set, objective, bid strategy,
targeting and promoted object are copied from a source you pick.

## Prerequisites

- Node.js 18+
- A Meta app with the Marketing API enabled
- (Optional) A Google Gemini API key for AI tagging

## Setup

```bash
git clone https://github.com/brenms/ads-uploader.git
cd ads-uploader
npm install
cp .env.example .env   # then fill in your values
npm run dev
```

The dev server runs on **http://localhost:5190**.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `VITE_META_SYSTEM_USER_TOKEN` | Yes | System-user token from Business Manager → System users → Generate token. Never expires; shared by every local profile. |
| `VITE_META_APP_ID` | Only for personal login | Your Meta app ID, used by the Facebook JS SDK fallback. Public by design. |
| `VITE_GEMINI_API_KEY` | No | Enables AI tagging. Users can supply their own key in-app instead. |

The app connects with the system-user token on load — no OAuth popup. A token can also be
pasted in-app (stored in `localStorage`), which is used only when the env var is empty.
Restart `npm run dev` after editing `.env`, since Vite inlines the value at build time.

> **Security note.** Vite inlines every `VITE_`-prefixed variable into the client bundle,
> so these values are visible to anyone who loads the app. They are not server secrets.
> Restrict any key you put here at the provider (HTTP referrer restrictions for Gemini),
> and prefer the in-app key entry, which stores the key in `localStorage` per-user.

## Meta app configuration

The token needs these scopes:

- `ads_management` — create and manage campaigns, ad sets, ads
- `ads_read` — read account structure
- `pages_show_list` — list Facebook Pages to publish ads from

When generating the system-user token, pick the real **App** (not the system-user id) and
assign the ad accounts and Pages to that system user in Business Settings — an unassigned
account simply won't show up in the pickers.

For the personal-login fallback, add your dev origin (and any tunnel domain) to **Valid
OAuth Redirect URIs** in the Meta app dashboard. To see data for users other than app
admins/developers/testers, the app needs **Advanced Access** for `ads_management` via App
Review.

## Scripts

```bash
npm run dev       # start dev server on :5190
npm run build     # typecheck, then production build
npm run preview   # serve the production build locally
```

## Project structure

```
src/
├─ components/
│  ├─ DropZone.tsx          # file intake, grid/list, per-file tagging
│  ├─ UploadPanel.tsx       # mode selection, account/page pickers, upload flow
│  ├─ TagBar.tsx            # batch tagging controls + custom fields
│  ├─ InlineAdBrowser.tsx   # campaign / ad set / ad browser
│  ├─ AdSettingsForm.tsx    # ad copy and settings
│  └─ PageSelector.tsx      # Facebook Page dropdown
└─ lib/
   ├─ meta.ts               # Graph API client — auth, uploads, campaigns
   ├─ creativeIntel.ts      # Gemini creative analysis
   ├─ taxonomy.ts           # tag vocabulary, persisted to localStorage
   └─ filePersistence.ts    # keeps staged files across reloads
```

## Known limitations

- **Assets shared into a Business Manager as *client* accounts may not appear.** Accounts
  and Pages are read from the system user's `assigned_ad_accounts` / `assigned_pages`
  edges, falling back to `/me/adaccounts` and `/me/accounts` for a personal login. Assets
  reachable only through a business relationship rather than a direct assignment need the
  `business_management` scope and the `/me/businesses` edges.
- **Not all Graph calls paginate.** `getAdAccounts` and `getPages` follow cursors; other
  edges (campaigns, ad sets, ads, `getAdVideos`) still cap at their `limit` and will
  silently truncate on large accounts. Notably `getAdVideos` caps at 200, so duplicate
  detection can miss matches on accounts with more videos than that.
- **Access tokens are handled client-side.** There is no backend; the Meta user token
  lives in the browser for the session. Fine for internal/personal use, but a server-side
  token exchange would be needed before exposing this to untrusted users.
- `npm run build` currently fails typechecking on a number of unused-variable errors and
  one type error in `DropZone.tsx`. `npm run dev` is unaffected.

## License

Unlicensed / private project.
