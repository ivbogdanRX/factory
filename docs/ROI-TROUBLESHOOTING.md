# ROI Troubleshooting Guide

## The Problem

Your ad automation system is showing low ROI. Based on the codebase analysis, here's why:

## Root Cause: Split-Brain Tracking

Your system uses **two separate attribution systems**:

1. **Meta Pixel** (`1033187746256419`) - Optimizes ad delivery
2. **RedTrack** - Your "source of truth" for conversions/revenue

This creates a critical dependency: **if RedTrack doesn't see conversions, your guardrails kill ads that Meta thinks are working.**

### How Attribution Works

Your ad links include tracking parameters:
```
https://visit.instfunds.com/6a7637e09275ed0cb84381e0?
  sub1={{ad.id}}&
  sub3={{campaign.id}}&
  [other params...]
```

RedTrack uses `sub1` (ad ID) and `sub3` (campaign ID) to attribute conversions back to specific Meta ads.

## Why ROI is Low: Guardrails Killing Good Campaigns

### Current Guardrail Rules (from `config/verticals.yaml`):

```yaml
guardrails:
  enabled: true
  adKillSpendUsd: 50        # Kill ad at $50 spend with 0 RedTrack conversions
  campaignGuardMinSpendUsd: 100  # Check campaign CPA at $100 spend
  maxCpaUsd: 120            # Pause campaign if CPA > $120
  extendUnderCpaUsd: 80     # Extend winning campaigns under $80 CPA
  scaleAtRoas: 1.0          # Scale budget at 1.0x ROAS
```

### The Problem:

**If RedTrack shows 0 conversions while Meta shows purchases:**
- ✅ Meta pixel fires → campaigns optimize for conversions
- ❌ RedTrack shows 0 conversions → guardrails think campaigns are failing
- 🔴 Result: Good ads get killed at $50 spend before they can prove themselves

## Common Tracking Issues

### Issue 1: RedTrack Pixel Not Firing
**Symptoms:**
- Meta shows purchases
- RedTrack shows 0 conversions
- Campaigns paused at $100 spend

**Diagnosis:**
```bash
# Check landing page tracking
curl -I "https://visit.instfunds.com/6a7637e09275ed0cb84381e0?sub1=TEST_AD&sub3=TEST_CAMPAIGN"

# Look for RedTrack pixel in HTML
curl "https://visit.instfunds.com/6a7637e09275ed0cb84381e0?sub1=TEST_AD&sub3=TEST_CAMPAIGN" | grep -i "redtrack"
```

**Fix:**
1. Install RedTrack pixel on the **conversion page** (not just landing page)
2. Verify pixel fires on purchase
3. Check RedTrack dashboard for TEST_AD and TEST_CAMPAIGN sub values

### Issue 2: Sub Parameters Not Passed Through
**Symptoms:**
- RedTrack pixel fires
- But conversions don't map back to specific ads
- All conversions show as "unknown source"

**Diagnosis:**
Check if your landing page redirects preserve URL parameters:
```javascript
// Landing page should pass params to conversion page
const params = new URLSearchParams(window.location.search);
const nextUrl = `https://conversion-page.com?${params.toString()}`;
```

**Fix:**
1. Ensure all redirects preserve query parameters
2. Test the full funnel with sub parameters
3. Verify parameters reach the conversion page

### Issue 3: Wrong RedTrack Campaign ID
**Symptoms:**
- Conversions appear in RedTrack
- But not under the expected campaign

**Diagnosis:**
```bash
# Extract campaign ID from your URL
# From: https://visit.instfunds.com/6a7637e09275ed0cb84381e0
# Campaign ID is: 6a7637e09275ed0cb84381e0
```

**Fix:**
Verify this campaign ID exists in RedTrack dashboard

### Issue 4: Meta Pixel Not Installed
**Symptoms:**
- No purchases showing in Meta
- Campaigns not optimizing
- High CPA

**Diagnosis:**
```bash
# Check conversion page for Meta pixel
curl "https://[conversion-page]" | grep -i "fbq.*purchase"
```

**Fix:**
1. Install Meta Pixel (`1033187746256419`) on conversion page
2. Add purchase event:
```html
<!-- Meta Pixel Code -->
<script>
fbq('track', 'Purchase', {value: VALUE, currency: 'USD'});
</script>
```

## How to Fix Your ROI

### Step 1: Run Diagnostic

```bash
npm install
npx tsx scripts/diagnose-tracking.ts
```

This will show you:
- Meta purchases vs RedTrack conversions per campaign
- Attribution mismatches
- Which tracking system is broken

### Step 2: Identify the Gap

Look for these patterns:

**Pattern A: Meta > 0, RedTrack = 0**
```
Meta:      $150 spent, 5 purchases, CPA $30
RedTrack:  0 conversions, $0 revenue
```
→ RedTrack pixel not firing or sub params not passing through

**Pattern B: Both = 0**
```
Meta:      $200 spent, 0 purchases
RedTrack:  0 conversions
```
→ Real campaign failure OR Meta pixel not installed

**Pattern C: Moderate mismatch**
```
Meta:      $150 spent, 5 purchases
RedTrack:  4 conversions, $280 revenue
```
→ Attribution window differences (normal)

### Step 3: Fix the Tracking

Based on the pattern above:

**For Pattern A (RedTrack = 0):**
1. Test conversion with params:
   ```
   https://visit.instfunds.com/6a7637e09275ed0cb84381e0?sub1=TEST&sub3=CAMPAIGN_TEST
   ```
2. Complete a test purchase
3. Check RedTrack for "TEST" and "CAMPAIGN_TEST" in sub columns
4. If not there, fix landing page → conversion page param passing

**For Pattern B (Both = 0):**
1. Install Meta pixel on conversion page
2. Test pixel with Meta Pixel Helper Chrome extension
3. Verify "Purchase" event fires on conversion

### Step 4: Tune Guardrails

Once tracking is fixed, you may want to adjust thresholds:

```yaml
guardrails:
  # Give ads more time before killing them
  adKillSpendUsd: 75  # Was 50

  # Allow higher CPA during learning phase
  maxCpaUsd: 150  # Was 120

  # Scale winners more aggressively
  scaleAtRoas: 0.8  # Was 1.0 (allows scaling at 80% ROAS)
```

## Quick Wins

### 1. Check Recent Campaigns

```bash
npx tsx scripts/diagnose-tracking.ts
```

### 2. Test Landing Page Tracking

```bash
# Visit with test params
open "https://visit.instfunds.com/6a7637e09275ed0cb84381e0?sub1=DIAGNOSTIC_TEST&sub3=TEST_CAMPAIGN_$(date +%s)"
```

Then check RedTrack dashboard for "DIAGNOSTIC_TEST"

### 3. Check for Killed Campaigns

```bash
# Look at database
sqlite3 data/ad-factory.db "SELECT * FROM guardrail_events ORDER BY created_at DESC LIMIT 20;"
```

Look for:
- Many "ad-kill" events → RedTrack not tracking
- High "campaign-cpa" events → CPA threshold too low

### 4. Review Angle Performance

```bash
npm run orchestrator -- angles
```

If all angles show $0 spend or 0 purchases despite campaigns running:
→ Meta insights API issue or campaigns not yet delivered

## Expected Results After Fix

**Healthy tracking looks like:**
```
Campaign: (IB) LNV AF 8-12
Meta:      $250 spent, 8 purchases, CPA $31.25
RedTrack:  7 conversions, $560 revenue, CPA $35.71
Mismatch:  12.5% (normal due to attribution windows)
```

**Guardrails should then:**
- ✅ Kill truly bad ads (high spend, 0 conversions)
- ✅ Extend winners under $80 CPA
- ✅ Scale at 1.0x ROAS
- ✅ Give campaigns time to optimize (up to $100 before CPA check)

## Need Help?

Run the diagnostic and share the output:
```bash
npx tsx scripts/diagnose-tracking.ts > roi-diagnostic.txt 2>&1
```

Common issues and fixes:
1. **"RedTrack not configured"** → Add `REDTRACK_API_KEY` to `.env`
2. **"Meta purchases > 0, RedTrack = 0"** → Landing page tracking broken
3. **"Both = 0"** → Campaigns not delivered yet OR pixel not installed
4. **"30%+ mismatch"** → Attribution window differences or partial tracking
