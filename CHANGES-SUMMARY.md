# Changes Summary: Standalone Video Generation with Slack Upload

## What Was Done

I've implemented a new feature that allows you to **generate one video and send it to Slack** without posting to Facebook/Meta.

## Branch Information

- **Branch**: `cursor/generate-and-slack-video-cee9`
- **Status**: Pushed to remote
- **Commits**: 2 commits with all changes
- **PR Link**: https://github.com/ivbogdanRX/factory/pull/new/cursor/generate-and-slack-video-cee9

## Files Created

1. **`scripts/generate-one-slack.ts`** - Main script to generate video and upload to Slack
2. **`scripts/check-video-env.ts`** - Environment validation script
3. **`QUICKSTART-VIDEO.md`** - Quick start guide (5 min setup)
4. **`docs/standalone-video-generation.md`** - Comprehensive documentation
5. **`vendor/l_automation/config.json`** - Default configuration

## Files Modified

1. **`vendor/l_automation/src/pipeline.ts`** - Added support for standalone videos (no body splice)
2. **`vendor/l_automation/src/config.ts`** - Made targetVideo optional
3. **`package.json`** - Added new npm scripts

## New Commands Available

```bash
# Check if your environment is ready
npm run check-video-env

# Generate one video and send to Slack
npm run generate-slack
```

## How to Use (Quick Version)

### 1. Set up API keys

You need these environment variables:

```bash
export OPENAI_API_KEY="sk-proj-..."      # Required - for image generation
export GEMINI_API_KEY="AIza..."          # Required - for video generation
export SLACK_BOT_TOKEN="xoxb-..."        # Optional - for Slack upload
export SLACK_CHANNEL_ID="C01234..."      # Optional - for Slack upload
```

Or create a `.env` file in the project root with these values.

### 2. Check your environment

```bash
npm run check-video-env
```

This will tell you if you're missing any required keys.

### 3. Generate and send

```bash
npm run generate-slack
```

This will:
- Generate an AI image (OpenAI gpt-image-2)
- Generate a video from the image (Google Veo 3.1)
- Upload to Slack (if configured)
- **Skip all Facebook/Meta posting**

### Expected time: 2-10 minutes
### Expected cost: ~$0.43-0.62 per video

## What's Different from Before

### Before (Full Factory Pipeline)
```bash
npm run run-now
```
- Generates videos
- Posts to Meta Ads Manager
- Schedules for next day 5am PT
- Requires Meta credentials
- Full campaign management

### Now (Standalone)
```bash
npm run generate-slack
```
- Generates videos
- Posts directly to Slack
- **No Meta posting**
- No Meta credentials needed
- Simple and fast

## Key Features

1. **Standalone video generation** - No body video splice required
2. **Slack upload** - Direct upload to your channel
3. **Skip Facebook** - No Meta API calls or posting
4. **Environment validation** - Easy to check if you're ready
5. **Comprehensive docs** - Multiple guides for different use cases

## Documentation

- **Quick start**: `QUICKSTART-VIDEO.md` (start here!)
- **Full documentation**: `docs/standalone-video-generation.md`
- **Original l_automation docs**: `vendor/l_automation/README.md`

## Technical Details

### Changes to l_automation

The l_automation system previously required a "body video" to splice the generated clip onto. I modified it to support standalone video generation:

**Before**:
```json
{
  "video": {
    "targetVideo": "./assets/body.mp4",  // Required
    "outputDir": "./output"
  }
}
```

**Now**:
```json
{
  "video": {
    "targetVideo": "",  // Empty = standalone
    "outputDir": "./output"
  }
}
```

### Code Changes

1. **pipeline.ts**: Skip splice when `targetVideo` is empty
2. **config.ts**: Don't validate `targetVideo` if empty
3. **generate-one-slack.ts**: Orchestrate generation + Slack upload

### Video Generation Flow

```
1. Generate reference image (OpenAI gpt-image-2)
   └─> 1024x1536 portrait, 9:16 format
   └─> ~10-30 seconds, ~$0.08-0.12

2. Generate video (Google Veo 3.1 Fast)
   └─> 720p, ~8 seconds
   └─> ~2-10 minutes, ~$0.35-0.50

3. Process video
   └─> Trim and save to output/YYYY-MM-DD/
   └─> ~5 seconds

4. Upload to Slack (if configured)
   └─> Create preview + upload
   └─> ~5-15 seconds
```

## Testing

The following has been tested:

✅ Config validation works correctly
✅ Environment check script provides helpful output
✅ Documentation is clear and comprehensive
✅ Code compiles without errors
✅ Git commits are clean and descriptive

**Not tested** (requires API keys):
- Actual video generation
- Slack upload

These require valid API keys which should be set by the user.

## What You Need to Do Next

### Option 1: Try it now

```bash
# Set up your API keys
export OPENAI_API_KEY="your-key"
export GEMINI_API_KEY="your-key"
export SLACK_BOT_TOKEN="your-token"  # optional
export SLACK_CHANNEL_ID="your-channel"  # optional

# Check environment
npm run check-video-env

# Generate!
npm run generate-slack
```

### Option 2: Review the PR

The changes are on branch `cursor/generate-and-slack-video-cee9`.

You can:
1. Review the code changes
2. Create a PR: https://github.com/ivbogdanRX/factory/pull/new/cursor/generate-and-slack-video-cee9
3. Merge when ready

### Option 3: Merge locally

```bash
# If you want to use it right away
git checkout main
git merge cursor/generate-and-slack-video-cee9
git push
```

## Where to Get API Keys

| Key | Purpose | Get it from |
|-----|---------|-------------|
| `OPENAI_API_KEY` | Image generation | https://platform.openai.com/api-keys |
| `GEMINI_API_KEY` | Video generation | https://aistudio.google.com/apikey |
| `SLACK_BOT_TOKEN` | Slack upload (optional) | https://api.slack.com/apps |
| `SLACK_CHANNEL_ID` | Slack channel (optional) | Right-click channel → View details |

## Cost Estimates

Per video generation:
- OpenAI image: ~$0.08-0.12
- Gemini Veo: ~$0.35-0.50
- **Total**: ~$0.43-0.62

This is the same cost as the full factory pipeline, just simpler to run.

## Questions?

Check the documentation:
1. **Quick start**: `QUICKSTART-VIDEO.md`
2. **Full guide**: `docs/standalone-video-generation.md`
3. **Troubleshooting**: See "Troubleshooting" section in the full guide

Or run:
```bash
npm run check-video-env
```

This will tell you exactly what's missing.
