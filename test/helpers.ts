import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

export async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (const deadline = Date.now() + 2000; Date.now() < deadline; await sleep(10)) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
}

export function assertAddsUp(approval: string): void {
  const amounts = [...approval.matchAll(/\$([\d,]+\.\d{2})/g)].map((m) => Math.round(Number(m[1].replace(/,/g, "")) * 100));
  const total = amounts.pop();
  assert.equal(amounts.reduce((s, a) => s + a, 0), total, approval);
}
