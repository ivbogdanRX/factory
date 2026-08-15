# Quick Start: Generate One Video & Send to Slack

This is a streamlined guide to generate a single video and send it to Slack, **without** posting to Facebook/Meta.

## 1. Check Your Environment

```bash
npm run check-video-env
```

This will tell you which API keys you need to set.

## 2. Set Up API Keys

### Option A: Create a .env file (Recommended)

```bash
cat > .env << 'EOF'
OPENAI_API_KEY=sk-proj-...your-key-here
GEMINI_API_KEY=AIza...your-key-here
SLACK_BOT_TOKEN=xoxb-...your-token
SLACK_CHANNEL_ID=C01234ABCDE
EOF
```

### Option B: Export for This Session

```bash
export OPENAI_API_KEY="sk-proj-...your-key-here"
export GEMINI_API_KEY="AIza...your-key-here"
export SLACK_BOT_TOKEN="xoxb-...your-token"
export SLACK_CHANNEL_ID="C01234ABCDE"
```

### Where to Get These Keys

| Key | Get it from |
|-----|-------------|
| **OPENAI_API_KEY** | https://platform.openai.com/api-keys |
| **GEMINI_API_KEY** | https://aistudio.google.com/apikey |
| **SLACK_BOT_TOKEN** | https://api.slack.com/apps → Your App → OAuth & Permissions |
| **SLACK_CHANNEL_ID** | Right-click Slack channel → View channel details → Copy ID |

> **Note**: Slack keys are optional. If not set, the video will be generated and saved locally, but not uploaded.

## 3. Generate & Send Video

```bash
npm run generate-slack
```

This will:
- Generate a reference image using OpenAI (gpt-image-2)
- Generate a video from the image using Google Veo
- Upload the video to your Slack channel
- **Skip all Facebook/Meta posting**

## Expected Output

```
🎬 Generating video using l_automation...

[generation progress logs...]

✅ Video generation complete!

📹 Video generated: /path/to/output/2026-08-13_114523_test-video.mp4

📤 Uploading to Slack...
✅ Video uploaded to Slack successfully!

✅ Done! Video generated and sent to Slack.
   (Skipped Facebook posting as requested)
```

## Generation Time & Costs

- **Duration**: 2-10 minutes total
  - Image generation: 10-30 seconds
  - Video generation: 2-10 minutes
  - Upload: 5-15 seconds

- **Cost per video**: ~$0.43-0.62
  - OpenAI image: ~$0.08-0.12
  - Gemini Veo: ~$0.35-0.50

## Output Location

Videos are saved to:
```
vendor/l_automation/output/YYYY-MM-DD/YYYY-MM-DD_HHMMSS_test-video.mp4
```

## Troubleshooting

### "Missing required environment variables"
- Run `npm run check-video-env` to see what's missing
- Make sure you've set OPENAI_API_KEY and GEMINI_API_KEY

### "Video generated but not sent to Slack"
- This means Slack credentials aren't set (that's okay!)
- The video is still saved locally
- Check the output path in the console

### Generation is taking a long time
- This is normal - Veo video generation takes 2-10 minutes
- Don't interrupt the process
- You'll see progress updates in the console

## Advanced Configuration

For more control over the video generation (prompts, quality, resolution), see:
- **Full docs**: `docs/standalone-video-generation.md`
- **l_automation config**: `vendor/l_automation/config.json`
- **l_automation README**: `vendor/l_automation/README.md`

## What's Different from the Full Factory?

| Feature | Full Factory (`npm run run-now`) | Standalone (`npm run generate-slack`) |
|---------|----------------------------------|---------------------------------------|
| Video generation | ✅ | ✅ |
| Facebook/Meta posting | ✅ | ❌ (skipped) |
| Slack notifications | ✅ | ✅ |
| Requires Meta credentials | ✅ | ❌ |
| Scheduling | ✅ (5am PT next day) | ❌ |
| Campaign management | ✅ | ❌ |
| Use case | Production ad campaigns | Quick testing & Slack sharing |

## Need Help?

- Check `docs/standalone-video-generation.md` for detailed documentation
- Run `npm run check-video-env` to validate your setup
- Check `vendor/l_automation/README.md` for l_automation details
