# 🚨 LOW ROI? START HERE

## The Smoking Gun

Your health check shows:
```
✅ Guardrails: ENABLED
❌ RedTrack: NOT CONFIGURED
⚠️  Guardrails will see 0 conversions and kill all campaigns!
```

**This is why your ROI is low.** Your system is killing every campaign because it can't see conversions.

## Immediate Fix

### Option 1: Add RedTrack (Recommended)

Add to `.env`:
```bash
REDTRACK_API_KEY=your_redtrack_api_key_here
```

Then verify tracking:
```bash
npx tsx scripts/health-check.ts
npx tsx scripts/diagnose-tracking.ts
```

### Option 2: Temporarily Disable Guardrails

In `config/verticals.yaml`:
```yaml
guardrails:
  enabled: false  # Change from true to false
```

⚠️ **Warning:** Campaigns will run without any automated safety checks.

### Option 3: Use Meta Attribution Only

If you trust Meta's pixel data, modify `apps/orchestrator/src/guardrails.ts` to use Meta's purchase data instead of RedTrack. (More complex, requires code changes)

## Why This Happens

### Your Setup:
1. **Guardrails** watch for low-performing campaigns
2. **RedTrack** should tell guardrails which campaigns convert
3. **RedTrack is missing** → guardrails see 0 conversions everywhere
4. **Guardrails kill everything** that spends >$50

### The Kill Pattern:
```
Campaign spends $50 → Guardrail checks RedTrack
RedTrack: "0 conversions" → Guardrail: "Kill this ad!"
Meta: "Wait, I saw 3 purchases!" → Too late, already paused
```

## How to Fix Permanently

### 1. Get Your RedTrack API Key

1. Log into RedTrack
2. Go to Settings → API
3. Copy your API key
4. Add to `.env`: `REDTRACK_API_KEY=...`

### 2. Verify Campaign ID

Your landing URL:
```
https://visit.instfunds.com/6a7637e09275ed0cb84381e0?...
                                ^^^^^^^^^^^^^^^^^^^^^^^^^
                                This is your RedTrack campaign ID
```

Verify this campaign exists in your RedTrack dashboard.

### 3. Test Tracking

```bash
# 1. Run health check
npx tsx scripts/health-check.ts

# 2. Copy the test URL it generates
# 3. Visit the URL in your browser
# 4. Complete a test purchase
# 5. Check RedTrack for "TEST_AD" and "TEST_CAMPAIGN" in sub columns
```

### 4. Check Meta Pixel

On your **conversion page** (NOT landing page):
1. Install Meta Pixel Helper Chrome extension
2. Visit conversion page
3. Look for pixel `1033187746256419`
4. Complete test purchase
5. Verify "Purchase" event fires

### 5. Run Diagnostic

```bash
npx tsx scripts/diagnose-tracking.ts
```

Look for:
- ✅ Meta purchases ≈ RedTrack conversions (within 20%)
- ❌ Meta > 0, RedTrack = 0 → Fix tracking first
- ❌ Both = 0 → Meta pixel not installed

## Current Guardrail Rules

```yaml
Ad Kill:       $50 spend + 0 conversions → Pause ad
Campaign CPA:  $100 spend + CPA > $120 → Pause campaign  
Extension:     CPA < $80 at flight end → Extend 1 day
Scale:         ROAS ≥ 1.0 → Increase budget
```

With RedTrack showing 0 conversions:
- Every ad dies at $50
- Every campaign dies at $100
- Nothing ever scales
- **This is why your ROI is low**

## Expected Timeline

Once you fix tracking:

**Day 1-2:** Campaigns in "learning" phase
- Meta: $0-100 spend, maybe 0-2 purchases
- RedTrack: 0-2 conversions
- CPA: High or infinite
- Status: Let them learn

**Day 3-4:** Campaigns stabilize
- Meta: $100-300 spend, 4-10 purchases
- RedTrack: 3-9 conversions  
- CPA: $30-80
- Status: Should extend or scale

**Day 5+:** Winners emerge
- Meta: $300-1000 spend, 15-40 purchases
- RedTrack: 12-35 conversions
- CPA: $25-60
- Status: Scaling up budget

## Quick Checklist

- [ ] Run `npx tsx scripts/health-check.ts`
- [ ] Add `REDTRACK_API_KEY` to `.env` OR disable guardrails
- [ ] Verify Meta pixel on conversion page
- [ ] Test landing URL with params
- [ ] Run `npx tsx scripts/diagnose-tracking.ts`
- [ ] Check for Meta vs RedTrack mismatch
- [ ] Let campaigns run 3+ days before judging

## Still Low ROI After Fixing Tracking?

Then check:

1. **Landing Page** - Is it converting traffic?
2. **Offer** - Is the product/service actually valuable?
3. **Ad Creative** - Are your videos compelling?
4. **Targeting** - Are you reaching the right audience?
5. **Bid Cap** - $25 might be too low for competitive keywords
6. **Budget** - $100/day might not be enough for proper testing

## Get Help

Share your diagnostic output:
```bash
npx tsx scripts/health-check.ts > health.txt 2>&1
npx tsx scripts/diagnose-tracking.ts > diagnostic.txt 2>&1
```

Then review both files to see exactly what's broken.
