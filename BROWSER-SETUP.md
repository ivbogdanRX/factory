# Browser-Based Video Generation Setup

You've configured the system to use **browser automation** instead of APIs:
- **Image generation**: ChatGPT web UI
- **Video generation**: Google Flow web UI

This requires a **one-time Playwright login** to authenticate both services.

## Setup Steps

### 1. Run the Login Helper

```bash
cd vendor/l_automation
npm run login
```

This will open a **real browser window** (not headless) where you need to:

1. **First tab: ChatGPT**
   - Log in to ChatGPT (https://chatgpt.com/)
   - Complete any 2FA if needed
   - Wait for the main chat interface to load

2. **Second tab: Google Flow**
   - Log in to Google Flow (https://labs.google/fx/tools/flow)
   - Use your Google account
   - Accept any terms/conditions if prompted

3. **Close the browser** when done
   - Your login sessions are saved to `.browser-profile/`
   - They'll be reused on future runs

### 2. Verify Config

Make sure your `config.json` has:

```json
{
  "imageSource": {
    "mode": "chatgpt"
  },
  "flow": {
    "backend": "browser"
  },
  "browser": {
    "headless": false
  }
}
```

### 3. Generate Video

```bash
cd ../..  # back to project root
npm run generate-slack
```

## Browser vs API: What's Different?

| Aspect | Browser (Current) | API (Previous) |
|--------|-------------------|----------------|
| **Image generation** | ChatGPT web UI | OpenAI API |
| **Video generation** | Google Flow web UI | Gemini API |
| **Login required** | ✅ Yes (one-time) | ❌ No |
| **Reliability** | ⚠️ Depends on UI stability | ✅ High |
| **Speed** | 🐌 Slower (UI automation) | ⚡ Faster (direct API) |
| **Cost** | 💰 Uses your subscriptions | 💳 Pay-per-use API |
| **API keys needed** | ❌ No | ✅ Yes |

## Pros & Cons

### ✅ Browser Approach (Current)
- No API keys needed
- Uses your existing ChatGPT Plus subscription
- Uses your Google Flow subscription/credits
- Good for testing without API costs

### ❌ Browser Approach Drawbacks
- Slower (UI automation overhead)
- Less reliable (UI changes can break it)
- Requires login maintenance
- Can't run truly headless
- One browser at a time (serialized)

### ✅ API Approach (Alternative)
- Faster and more reliable
- Fully headless
- Can parallelize
- No login maintenance
- Stable API contracts

### ❌ API Approach Drawbacks
- Requires API keys
- Pay-per-use (~$0.43-0.62 per video)
- Separate from your subscriptions

## Switching Back to API

To switch back to the faster API approach:

1. Edit `vendor/l_automation/config.json`:
   ```json
   {
     "imageSource": {
       "mode": "openai"
     },
     "flow": {
       "backend": "api"
     }
   }
   ```

2. Add keys to your `.env`:
   ```bash
   OPENAI_API_KEY=sk-proj-...
   GEMINI_API_KEY=AIza...
   ```

3. No browser login needed!

## Troubleshooting

### Login browser doesn't open
- Check that `browser.headless` is set to `false` in config.json
- Make sure you're in the `vendor/l_automation` directory

### Login sessions expire
- Re-run `npm run login` when needed
- Sessions are stored in `.browser-profile/`

### "Profile is already in use" error
- Close any Chrome windows opened from `.browser-profile/`
- Only one browser process can use the profile at a time

### UI elements not found
- ChatGPT or Flow UI may have changed
- Check `vendor/l_automation/src/chatgpt-image.ts` and `src/flow.ts` for selector updates
- Consider switching to API mode for better reliability

## Current Configuration Summary

Your system is now configured for:
- ✅ **Browser-based generation** (ChatGPT + Flow)
- ✅ **Slack upload** (keys already in .env)
- ✅ **No Meta/Facebook posting** (standalone mode)

Next step: Run `npm run login` in the `vendor/l_automation` directory!
