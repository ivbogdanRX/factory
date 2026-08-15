# Ad Factory Architecture & ROI Flow

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Ad Factory System                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────┐
        │   1. Generate Creatives (10am PT)    │
        │   vendor/l_automation (Veo/Flow)     │
        └──────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────┐
        │   2. Upload to Meta                  │
        │   Meta Graph API                     │
        └──────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────┐
        │   3. Schedule for Tomorrow 5am PT    │
        │   start_time parameter               │
        └──────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────┐
        │   4. Ads Go Live (5am PT)            │
        │   Meta serves ads to users           │
        └──────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────┐
        │   5. User Clicks Ad                  │
        │   URL: landing.com?sub1={{ad.id}}    │
        └──────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────┐
        │   6. Landing Page                    │
        │   Preserves sub1, sub3 params        │
        └──────────────────────────────────────┘
                              │
                              ▼
        ┌──────────────────────────────────────┐
        │   7. User Converts (Purchase)        │
        │   - Meta Pixel fires                 │
        │   - RedTrack pixel fires             │
        └──────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    ▼                   ▼
          ┌──────────────┐    ┌──────────────┐
          │ Meta Insights│    │  RedTrack    │
          │ Purchase: +1 │    │ Conversion:+1│
          │ ad.id: 123   │    │ sub1: 123    │
          │ campaign: 456│    │ sub3: 456    │
          └──────────────┘    └──────────────┘
                    │                   │
                    └─────────┬─────────┘
                              ▼
        ┌──────────────────────────────────────┐
        │   8. Guardrails Evaluate (15min)     │
        │   Compare Meta spend vs RT conversions│
        └──────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌─────────┐    ┌──────────┐   ┌──────────┐
        │ Kill Ad │    │ Extend   │   │ Scale Up │
        │ $50+    │    │ Winner   │   │ Budget   │
        │ 0 conv  │    │ Low CPA  │   │ Good ROAS│
        └─────────┘    └──────────┘   └──────────┘
```

## Data Flow: Where Conversions Get Lost

### Happy Path (Working Correctly)

```
User clicks ad
  → Landing: site.com?sub1=AD_123&sub3=CAMP_456
  → Conversion page: (params preserved)
  → Purchase event fires
    ├─ Meta Pixel: "Purchase for ad_123"
    └─ RedTrack: "Conversion for sub1=AD_123, sub3=CAMP_456"
  → Guardrails see:
    - Meta: $50 spent, 2 purchases
    - RedTrack: 2 conversions, $140 revenue
  → Decision: Keep running, good CPA!
```

### Broken Path (Low ROI Scenario)

```
User clicks ad
  → Landing: site.com?sub1=AD_123&sub3=CAMP_456
  → Conversion page: site.com/checkout (params lost! 😱)
  → Purchase event fires
    ├─ Meta Pixel: "Purchase for ad_123" ✅
    └─ RedTrack: "Conversion for sub1=?, sub3=?" ❌
  → Guardrails see:
    - Meta: $50 spent, 2 purchases
    - RedTrack: 0 conversions (can't attribute!)
  → Decision: Kill ad! 0 conversions at $50 🔴
```

### Why This Breaks ROI

1. **Campaign is actually working** (Meta sees 2 purchases)
2. **RedTrack can't see them** (sub params lost)
3. **Guardrails think it's failing** (0 conversions)
4. **Ad gets killed at $50** (before it can prove itself)
5. **Repeat for every ad** → Low ROI across the board

## The Attribution Problem

### Two Sources of Truth

Your system uses **dual attribution**:

| Metric | Meta Insights | RedTrack | Used By |
|--------|--------------|----------|---------|
| Spend | ✅ Source of truth | ❌ Not tracked | Guardrails |
| Purchases/Conversions | ⚠️ "Not trusted" | ✅ Source of truth | Guardrails |
| Revenue | ❌ Not available | ✅ Available | Scaling decisions |
| CPA | Calculated | Calculated | All decisions |

**The Problem:** Guardrails use Meta spend + RedTrack conversions to calculate CPA.

```javascript
// From guardrails.ts line 137
const rtCpa = rtConversions > 0 ? metaSpend / rtConversions : null;
```

If `rtConversions = 0`, then CPA = infinite → Kill the ad!

### Why Not Just Use Meta?

The code comment explains:
```typescript
// guardrails.ts line 6-8
// CONVERSIONS / REVENUE come from RedTrack (the user doesn't trust Meta's
// conversion attribution). Attribution back to Meta ids rides on the sub
// params in the ad links: sub1={{ad.id}}, sub3={{campaign.id}}.
```

You explicitly chose RedTrack because you don't trust Meta's conversion attribution.

## ROI Calculation Path

### Current System (Using RedTrack)

```
ROI = (RedTrack Revenue - Meta Spend) / Meta Spend

Example with tracking broken:
ROI = ($0 - $500) / $500 = -100% 😱

Example with tracking working:
ROI = ($850 - $500) / $500 = 70% 🎉
```

### If Using Meta Only

```
Meta Purchase Value = $85/ea (average)
ROI = (Meta Purchases * $85 - Meta Spend) / Meta Spend

Example:
ROI = (10 * $85 - $500) / $500 = 70% 🎉
```

**But you don't trust Meta's attribution**, so this won't work for you.

## Guardrail Decision Tree

```
Every 15 minutes, for each live campaign:

1. Get Meta spend (always works)
   ↓
2. Get RedTrack conversions (requires API key + tracking)
   ↓
3. Calculate CPA = spend / conversions
   ↓
4. Apply rules:

   Rule A: Single ad check
   IF spend >= $50 AND conversions = 0
   → Pause this ad
   
   Rule B: Campaign CPA check  
   IF spend >= $100 AND CPA > $120
   → Pause whole campaign
   
   Rule C: Extension check (at flight end)
   IF CPA < $80
   → Extend flight 1 more day
   
   Rule D: Scaling check
   IF spend >= $75 AND ROAS >= 1.0
   → Increase daily budget to next step
```

## The $50 Death Zone

With RedTrack broken, **every ad dies at $50**:

```
Timeline of a doomed ad:

Hour 0:  Ad goes live, status: ACTIVE
Hour 1:  Spend $5, 0 conversions (still learning)
Hour 2:  Spend $12, 0 conversions (still learning)
Hour 3:  Spend $25, 1 purchase (Meta sees it) ✅
         → RedTrack: 0 conversions (doesn't see it) ❌
Hour 4:  Spend $35, 2 purchases (Meta)
         → RedTrack: 0 conversions
Hour 5:  Spend $52, 3 purchases (Meta)
         → Guardrail: "$52 spent, 0 conversions? KILL IT!" 🔴
         → Status: PAUSED

Meta thinks: "Hey, I got 3 purchases for $52, that's great!"
RedTrack thinks: "No conversions"
Guardrails think: "Failed campaign, pause it"
You think: "Why is my ROI so low??" 😭
```

## Fix Strategy

### Option 1: Fix RedTrack (Recommended)

**Pros:**
- Original design intent
- Revenue tracking
- Multi-channel attribution
- More control over attribution windows

**Cons:**
- Requires RedTrack subscription
- More complex setup
- More potential points of failure

**How:**
1. Add `REDTRACK_API_KEY` to `.env`
2. Ensure RedTrack pixel on conversion page
3. Test with `scripts/health-check.ts`
4. Verify with `scripts/diagnose-tracking.ts`

### Option 2: Use Meta Only

**Pros:**
- Simpler setup
- One less thing to break
- Meta's attribution is usually decent

**Cons:**
- No revenue tracking
- Trust Meta's attribution
- Less control

**How:** Modify `guardrails.ts` to use Meta's purchase data instead of RedTrack.

### Option 3: Disable Guardrails

**Pros:**
- Immediate fix
- No tracking needed

**Cons:**
- No protection against bad campaigns
- Manual monitoring required
- Risk of high spend with no conversions

**How:** Set `enabled: false` in `config/verticals.yaml`

## Recommended: Fix RedTrack

Since you explicitly set up dual attribution, you likely have a good reason not to trust Meta. 

The fix is straightforward:
1. Get RedTrack API key
2. Test tracking end-to-end
3. Verify params pass through redirects
4. Ensure pixels fire on conversion page

Once fixed, your campaigns should show:
- Meta and RedTrack data align (within 10-20%)
- Good ads survive past $50
- Winners scale up
- ROI improves dramatically

## Testing Your Fix

After implementing the fix:

```bash
# 1. Health check (should pass all)
npx tsx scripts/health-check.ts

# 2. Run a test campaign
npm run dry-run  # Safe, no Meta writes

# 3. Or run for real
npm run run-now

# 4. Monitor results
npx tsx scripts/diagnose-tracking.ts

# 5. Check Slack
/adops status
/adops perf
```

Within 3-5 days you should see:
- Campaigns surviving past $50
- Good CPAs (under $80)
- Winners extending/scaling
- Improved overall ROI
