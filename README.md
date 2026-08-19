# Ad Factory

Daily automation that generates ad creatives, uploads them to a Meta ad
account, and schedules delivery for **next day 5:00am PT** — giving you an
overnight review window. Control it from a local web portal or Slack.

The originals of both source projects are untouched; this repo works on
**copies** under `vendor/`:

- `vendor/l_automation` — creative factory (Veo/Flow hooks + captions + body splice)
- `vendor/ads-uploader` — manual Meta upload SPA (escape hatch) + source of the ported Graph code

## How a day works

1. At the run hour (default 10:00am PT) the orchestrator generates N creatives
   per enabled vertical via the vendored studio.
2. Videos are uploaded to Meta, ads are created under a fresh ad set (or an
   existing one) with `start_time` = next day 5:00am PT. No spend until then.
3. Slack gets a notification with Pause / Kill buttons. You can also act in
   the portal or with `/adops` commands.

The portal at `http://localhost:5180` is a read-only mobile "glance" hub
(status, money today, flights, angles, health). The full management console
(config editing, run controls, creative previews) is at `/manage`. The glance
page can also be hosted on Vercel — see `portal-vercel/README.md` — with the
Mac pushing status snapshots every minute, so you can check it from anywhere.
4. At 5:00am PT the ads go live unless you paused/killed them.

## Apps

| App | Command | Port |
|---|---|---|
| Orchestrator + portal | `npm run orchestrator` | http://127.0.0.1:5180 |
| Creative studio (vendored) | `npm run studio` | http://127.0.0.1:5174 |
| Slack bot (Socket Mode) | `npm run slack-bot` | — |
| Manual uploader SPA | `npm run uploader` | http://127.0.0.1:5190 |

## Setup

```bash
npm install
cp .env.example .env   # fill in tokens (see below)
```

`vendor/l_automation` keeps its own `.env` (Gemini/OpenAI keys) and
`config.json` (campaigns) — both copied from the original project. Its browser
profile was copied too; if Flow/Pinterest sessions expired, re-login with:

```bash
cd vendor/l_automation && npm run login
```

### .env values

- `META_SYSTEM_USER_TOKEN` — system-user token with `ads_management`,
  assigned to the ad account and page (same token ads-uploader uses).
- `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` — create a Slack app:
  1. https://api.slack.com/apps → Create New App → From scratch
  2. **Socket Mode** → enable → create app-level token with
     `connections:write` (`xapp-…` → `SLACK_APP_TOKEN`)
  3. **OAuth & Permissions** → bot scopes `chat:write`, `commands`,
     `files:write` (needed to post finished videos into the channel) → install
     to workspace (`xoxb-…` → `SLACK_BOT_TOKEN`)
  4. **Slash Commands** → create `/adops` (request URL not needed in Socket Mode)
  5. **Interactivity & Shortcuts** → toggle on
  6. Invite the bot to your ops channel, put the channel id in
     `SLACK_CHANNEL_ID`, your user id in `SLACK_ALLOWED_USER_IDS`
- `RUN_HOUR_PT` — daily generation hour (also editable in the portal)
- `DRY_RUN=1` — full pipeline but no Meta writes (for testing)

### Vertical config

`config/verticals.yaml` — one block per vertical. Each vertical belongs to a
**product family** (`loans` or `debt`). Families share the factory process but
are isolated: they cannot share a studio campaign, Meta pixel, or RedTrack
landing link, and finished videos land in `vendor/l_automation/output/<family>/<campaign-id>/`.
VA loans is enabled; debt audiences (`debt-seniors`, `debt-teachers`,
`debt-union-workers`, `debt-nurses`, `debt-veterans`) are wired but off until
you fill each one's debt pixel and RedTrack URL.

All editable in the portal too. Three posting modes:

- **new-campaign** (default, used by VA loans): a fresh CBO campaign every day.
  Set `objective`, `cboDailyBudgetCents`, `bidStrategy` (highest volume =
  `LOWEST_COST_WITHOUT_CAP`, or `LOWEST_COST_WITH_BID_CAP` + `bidCapCents`),
  `pixelId` + `pixelEvent`, and `specialAdCategories`. Naming templates
  (`naming.campaign/adSet/ad`) support `{vertical}`, `{date}` (M-D go-live
  date) and `{n}`; the automated ones use the `(IB) … AF {date}` convention so
  they're easy to tell apart from manual campaigns.
- **new-adset**: new ad set daily under an existing `parentCampaignId`.
  Optional `templateAdSetId` clones targeting/budget/optimization.
- **existing-adset**: adds ads to `existingAdSetId` (created paused, activated
  at go-live).

### Angles & flights

Each studio campaign variant (persona/scene, e.g. UGC selfie vet vs older
veteran vs military spouse) is a creative **angle**. The daily mix is sampled
with weights from past results — winners get more slots, losers still get
occasional retests. Ads are tagged `[angle-id]` in their Meta ad names, and
the angle shows on each creative in the portal.

Campaigns auto-pause after `schedule.flightDays` (default 3) days live. At
flight end the orchestrator pulls final per-ad spend/purchases, stores them
per angle, and posts the breakdown + updated angle leaderboard to Slack.
Angles are edited in the studio campaign's `variants` (vendor
`config.json` or the Creative Studio UI).

## Slack commands

```
/adops status                    active runs + go-live countdown
/adops pause  [vertical|runId]   pause scheduled ads
/adops resume [vertical|runId]   resume paused ads
/adops kill   [vertical|runId]   pause + cancel (never goes live)
/adops skip                      skip tomorrow's daily run once
/adops run    [vertical]         generate + schedule right now
/adops perf                      spend / purchases / CPA for automated campaigns
/adops angles                    creative angle leaderboard + mix bias
/adops health                    run the full healthcheck now
```

## Testing

```bash
npm run dry-run    # generate creatives, skip Meta writes
npm run run-now    # full live run (uploads + schedules real ads)
```

## Always-on (launchd)

On this Mac mini the agents live in `~/Library/LaunchAgents/com.adfactory.*.plist`
and start from `/Users/ivanbogdan/Desktop/factory/factory`. Glance is served
on the LAN at **http://Ivans-Mac-mini.local:5180** (no Vercel). Write APIs stay
localhost-only; Slack `/adops` still talks to `127.0.0.1:5180`.

```bash
launchctl list | grep adfactory        # check status
tail -f data/logs/orchestrator.log     # watch logs
```

The Slack bot service is installed but **unloaded** until you fill the Slack
tokens in `.env`. Once they're set:

```bash
launchctl load ~/Library/LaunchAgents/com.adfactory.slackbot.plist
```

After changing `.env`, restart services to pick it up:

```bash
launchctl kickstart -k gui/$(id -u)/com.adfactory.orchestrator
```

Keep the Mac awake: System Settings → Energy → prevent sleeping when display
is off (or run `caffeinate -s` in a background terminal). The browser backend
needs a logged-in user session.

To stop everything: `launchctl unload ~/Library/LaunchAgents/com.adfactory.*.plist`
