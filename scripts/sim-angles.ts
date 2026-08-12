/** One-off sanity check: run pickAngles 100x and print the distribution. */
import { pickAngles } from "../apps/orchestrator/src/angles.js";
import { getVertical } from "../apps/orchestrator/src/verticals.js";

const v = getVertical("va-loans");
if (!v) throw new Error("va-loans vertical not found");

const UGC = new Set(v.angles.ugcAngleIds);
const perAngle = new Map<string, number>();
let ugcTotal = 0;
let total = 0;
const RUNS = 100;
for (let i = 0; i < RUNS; i++) {
  const picked = pickAngles(v.id, v.creativeCampaignId, v.dailyCount, v.angles);
  if (picked.length !== v.dailyCount) throw new Error(`expected ${v.dailyCount} picks, got ${picked.length}`);
  for (const a of picked) {
    perAngle.set(a.id, (perAngle.get(a.id) ?? 0) + 1);
    if (UGC.has(a.id)) ugcTotal++;
    total++;
  }
}
console.log(`dailyCount=${v.dailyCount} ugcShare=${v.angles.ugcShare} runs=${RUNS}`);
console.log(`UGC share of picks: ${(100 * ugcTotal / total).toFixed(1)}% (${ugcTotal}/${total})`);
for (const [id, n] of [...perAngle.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${UGC.has(id) ? "[UGC]  " : "[other]"} ${id}: ${n} (${(100 * n / total).toFixed(1)}%)`);
}
const one = pickAngles(v.id, v.creativeCampaignId, v.dailyCount, v.angles);
console.log("example day:", one.map((a) => a.id).join(", "));
