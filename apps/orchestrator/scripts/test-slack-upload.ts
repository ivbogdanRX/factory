// One-off: verify video upload to Slack works (run with npx tsx).
import { uploadFileToSlack, postSlack } from "../src/slack.js";

const file = process.argv[2];
if (!file) {
  console.error("usage: tsx test-slack-upload.ts <file>");
  process.exit(1);
}

const ok = await uploadFileToSlack(file, "test-clip.mp4 [upload test — ignore]");
console.log(ok ? "upload OK" : "upload FAILED");
if (ok) await postSlack(":white_check_mark: video upload test succeeded — finished creatives will be sent here going forward.");
process.exit(ok ? 0 : 1);
