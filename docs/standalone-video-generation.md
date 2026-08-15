# Standalone Video Generation with Slack Upload

This guide explains how to generate a single video using the l_automation system and automatically upload it to Slack (without posting to Facebook/Meta).

## Quick Start

```bash
npm run generate-slack
```

This will:
1. Generate one video using the l_automation system (with AI image generation + Veo video)
2. Automatically upload it to your Slack channel
3. Skip all Facebook/Meta posting

## Prerequisites

You need the following API keys set as environment variables:

### Required for Video Generation

1. **OPENAI_API_KEY** - For AI image generation (generates the reference image)
   - Get it from: https://platform.openai.com/api-keys
   - Used by: `gpt-image-2` model for creating realistic reference images

2. **GEMINI_API_KEY** - For Veo video generation (generates the video from the image)
   - Get it from: https://aistudio.google.com/apikey
   - Used by: Veo 3.1 Fast model via Gemini API

### Required for Slack Upload (Optional)

3. **SLACK_BOT_TOKEN** - Your Slack bot token (starts with `xoxb-`)
   - Get it from: https://api.slack.com/apps → Your App → OAuth & Permissions
   - Required scopes: `chat:write`, `files:write`

4. **SLACK_CHANNEL_ID** - The channel where videos will be posted
   - Find it in Slack: Right-click channel → View channel details → Copy channel ID
   - Example: `C01234ABCDE`

## Setting Up Environment Variables

### Option 1: Create a .env file (recommended)

```bash
# In the project root
cat > .env << 'EOF'
OPENAI_API_KEY=your-openai-key-here
GEMINI_API_KEY=your-gemini-key-here
SLACK_BOT_TOKEN=xoxb-your-slack-token
SLACK_CHANNEL_ID=C01234ABCDE
EOF
```

### Option 2: Export for current session

```bash
export OPENAI_API_KEY="your-openai-key-here"
export GEMINI_API_KEY="your-gemini-key-here"
export SLACK_BOT_TOKEN="xoxb-your-slack-token"
export SLACK_CHANNEL_ID="C01234ABCDE"
```

## Configuration

The video generation is configured in `vendor/l_automation/config.json`:

```json
{
  "imageSource": {
    "mode": "openai",
    "openai": {
      "model": "gpt-image-2",
      "size": "1024x1536",
      "quality": "high"
    }
  },
  "flow": {
    "backend": "api",
    "prompt": "A news reporter at a desk delivers urgent breaking news...",
    "apiModel": "veo-3.1-fast-generate-preview",
    "aspectRatio": "9:16",
    "resolution": "720p"
  },
  "video": {
    "targetVideo": "",
    "outputDir": "./output"
  }
}
```

Key settings:
- **imageSource.mode**: `"openai"` for AI-generated images
- **flow.backend**: `"api"` for fast Gemini API (vs browser automation)
- **video.targetVideo**: Empty string for standalone videos (no splice)

## What Happens During Generation

1. **Image Generation** (~10-30 seconds)
   - OpenAI GPT-Image-2 generates a photorealistic reference image
   - 1024x1536 portrait, vertical 9:16 format

2. **Video Generation** (~2-10 minutes)
   - Gemini Veo 3.1 Fast generates video from the image
   - 720p resolution, ~8 seconds duration
   - Uses the configured prompt for camera movement and style

3. **Video Processing** (~5 seconds)
   - Trims and normalizes the generated video
   - Saves to `vendor/l_automation/output/YYYY-MM-DD/`

4. **Slack Upload** (if configured)
   - Creates a preview clip for faster upload
   - Uploads to your configured Slack channel
   - Posts with title "Generated Video"

## Output

Videos are saved to:
```
vendor/l_automation/output/
  └── 2026-08-13/
      └── 2026-08-13_114203_test-video.mp4
```

Filename format: `YYYY-MM-DD_HHMMSS_<name>.mp4`

## Troubleshooting

### "GEMINI_API_KEY not set"
- Set the environment variable as shown above
- Verify with: `echo $GEMINI_API_KEY`

### "OPENAI_API_KEY not set"
- Set the environment variable as shown above
- Verify with: `echo $OPENAI_API_KEY`

### "Slack credentials not set"
- This is a warning only - the video will still be generated
- The video path will be printed to the console
- You can manually upload it or set up Slack credentials later

### Generation takes a long time
- Veo video generation typically takes 2-10 minutes
- The script will show progress updates
- Don't interrupt the process

### Video quality issues
- Increase resolution: Change `flow.resolution` to `"1080p"`
- Use better model: Change `apiModel` to `"veo-3.1-generate-preview"`
- Adjust quality: Change `imageSource.openai.quality` to `"high"`

## Advanced Usage

### Custom prompts

Edit `vendor/l_automation/config.json`:

```json
{
  "flow": {
    "prompt": "Your custom camera and scene description here"
  }
}
```

### Different image sources

```json
{
  "imageSource": {
    "mode": "pinterest",
    "pinterest": {
      "query": "cinematic portrait photography"
    }
  }
}
```

### Adding captions

```json
{
  "captions": {
    "enabled": true,
    "dialogue": "Your spoken text here",
    "wordsPerGroup": 4
  }
}
```

## Comparison: With vs Without Facebook

### Old Way (Full Factory Pipeline)
```bash
npm run run-now
```
- Generates videos
- Uploads to Meta Ads Manager
- Schedules for 5am PT next day
- Posts notifications to Slack
- Requires Meta credentials

### New Way (Standalone with Slack)
```bash
npm run generate-slack
```
- Generates videos
- Uploads directly to Slack
- **Skips all Meta/Facebook steps**
- No Meta credentials needed
- Faster and simpler for testing

## Cost Estimates

Per video generation:

- **OpenAI Image**: ~$0.08-0.12 (gpt-image-2, 1024x1536, high quality)
- **Gemini Veo**: ~$0.35-0.50 per 8-second video (Veo 3.1 Fast, 720p)
- **Total**: ~$0.43-0.62 per video

For 1080p or standard Veo model, costs increase proportionally.

## Related Documentation

- Full l_automation README: `vendor/l_automation/README.md`
- Factory orchestrator: `README.md`
- Slack bot setup: `apps/slack-bot/`
