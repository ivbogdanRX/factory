#!/usr/bin/env tsx
/**
 * Check if the environment is properly configured for video generation.
 */

import "dotenv/config";

interface EnvCheck {
  name: string;
  key: string;
  required: boolean;
  purpose: string;
  setupUrl: string;
}

const checks: EnvCheck[] = [
  {
    name: "OpenAI API Key",
    key: "OPENAI_API_KEY",
    required: true,
    purpose: "Generate AI reference images (gpt-image-2)",
    setupUrl: "https://platform.openai.com/api-keys"
  },
  {
    name: "Gemini API Key",
    key: "GEMINI_API_KEY",
    required: true,
    purpose: "Generate videos with Veo 3.1",
    setupUrl: "https://aistudio.google.com/apikey"
  },
  {
    name: "Slack Bot Token",
    key: "SLACK_BOT_TOKEN",
    required: false,
    purpose: "Upload videos to Slack (optional)",
    setupUrl: "https://api.slack.com/apps"
  },
  {
    name: "Slack Channel ID",
    key: "SLACK_CHANNEL_ID",
    required: false,
    purpose: "Slack channel for uploads (optional)",
    setupUrl: "Right-click channel → View details"
  }
];

function main() {
  console.log("🔍 Checking environment for video generation...\n");
  
  let allRequired = true;
  let hasSlack = true;
  
  for (const check of checks) {
    const value = process.env[check.key];
    const isSet = !!value;
    
    if (isSet) {
      const preview = value.length > 20 ? value.substring(0, 20) + "..." : value;
      console.log(`✅ ${check.name}: Set (${preview})`);
    } else {
      const icon = check.required ? "❌" : "⚠️ ";
      console.log(`${icon} ${check.name}: Not set`);
      console.log(`   Purpose: ${check.purpose}`);
      console.log(`   Get it: ${check.setupUrl}\n`);
      
      if (check.required) {
        allRequired = false;
      } else {
        hasSlack = false;
      }
    }
  }
  
  console.log("\n" + "=".repeat(60));
  
  if (allRequired && hasSlack) {
    console.log("✅ All environment variables are set!");
    console.log("\nYou can now generate videos and upload to Slack:");
    console.log("   npm run generate-slack");
  } else if (allRequired) {
    console.log("⚠️  Video generation is ready, but Slack upload is not configured.");
    console.log("\nYou can generate videos (they'll be saved locally):");
    console.log("   npm run generate-slack");
    console.log("\nTo enable Slack upload, set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID.");
  } else {
    console.log("❌ Missing required environment variables.");
    console.log("\nTo generate videos, you need:");
    console.log("   1. OPENAI_API_KEY - for image generation");
    console.log("   2. GEMINI_API_KEY - for video generation");
    console.log("\nSet them in .env file or export as environment variables.");
    console.log("\nSee docs/standalone-video-generation.md for detailed setup instructions.");
    process.exit(1);
  }
}

main();
