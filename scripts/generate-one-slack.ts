#!/usr/bin/env tsx
/**
 * Generate one video and send it to Slack (no Meta posting).
 * 
 * Usage: tsx scripts/generate-one-slack.ts
 */

import "dotenv/config";
import { spawn } from "child_process";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const VENDOR_DIR = join(import.meta.dirname, "..", "vendor", "l_automation");
const OUTPUT_DIR = join(VENDOR_DIR, "output");

async function findNewestVideo(): Promise<string | null> {
  try {
    const dates = readdirSync(OUTPUT_DIR);
    if (dates.length === 0) return null;

    // Get the most recent date folder
    const sortedDates = dates.sort().reverse();
    
    for (const dateDir of sortedDates) {
      const datePath = join(OUTPUT_DIR, dateDir);
      if (!statSync(datePath).isDirectory()) continue;
      
      const files = readdirSync(datePath)
        .filter(f => f.endsWith(".mp4"))
        .map(f => ({
          name: f,
          path: join(datePath, f),
          mtime: statSync(join(datePath, f)).mtime.getTime()
        }))
        .sort((a, b) => b.mtime - a.mtime);
      
      if (files.length > 0) {
        return files[0].path;
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

async function uploadToSlack(videoPath: string): Promise<boolean> {
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackChannelId = process.env.SLACK_CHANNEL_ID;

  if (!slackBotToken || !slackChannelId) {
    console.log("\n❌ Slack credentials not set. Video generated at:", videoPath);
    console.log("   Set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID to enable Slack upload.");
    return false;
  }

  console.log("\n📤 Uploading to Slack...");

  try {
    // Use the existing Slack upload functionality
    const { uploadVideoPreviewToSlack } = await import("../apps/orchestrator/src/slack.js");
    const success = await uploadVideoPreviewToSlack(videoPath, "VA Loans — full ad (no Meta)");
    
    if (success) {
      console.log("✅ Video uploaded to Slack successfully!");
      return true;
    } else {
      console.log("❌ Slack upload failed (check logs above)");
      return false;
    }
  } catch (error: any) {
    console.error("❌ Slack upload error:", error.message);
    return false;
  }
}

function campaignArgs(): string[] {
  const extra = process.argv.slice(2);
  if (extra.includes("--campaign")) return extra;
  return ["--campaign", "va-loans-veterans", ...extra];
}

async function generateVideo(): Promise<string | null> {
  const args = campaignArgs();
  console.log("🎬 Generating video using l_automation...\n");
  console.log(`   args: ${args.join(" ")}\n`);

  return new Promise((resolve, reject) => {
    const proc = spawn("npm", ["run", "run", "--", ...args], {
      cwd: VENDOR_DIR,
      stdio: "inherit",
    });

    proc.on("close", async (code) => {
      if (code === 0) {
        console.log("\n✅ Video generation complete!");
        const videoPath = await findNewestVideo();
        resolve(videoPath);
      } else {
        reject(new Error(`Video generation failed with exit code ${code}`));
      }
    });

    proc.on("error", (error) => {
      reject(error);
    });
  });
}

async function main() {
  try {
    // Generate the video
    const videoPath = await generateVideo();
    
    if (!videoPath) {
      console.error("\n❌ Could not find generated video in output directory");
      process.exit(1);
    }

    console.log(`\n📹 Video generated: ${videoPath}`);

    // Upload to Slack
    const uploaded = await uploadToSlack(videoPath);

    if (uploaded) {
      console.log("\n✅ Done! Video generated and sent to Slack.");
      console.log("   (Skipped Facebook posting as requested)");
    } else {
      console.log("\n⚠️  Video generated but not sent to Slack.");
      console.log(`   You can find it at: ${videoPath}`);
    }

  } catch (error: any) {
    console.error("\n❌ Error:", error.message);
    process.exit(1);
  }
}

main();
