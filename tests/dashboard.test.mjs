import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createDashboardServer } from "../dashboard/server.mjs";

test("dashboard serves the sandbox modules and the unchanged committed live evidence asset", async () => {
  const server = createDashboardServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Can your AI agent/);
    assert.match(pageHtml, /Run Sandbox Test/);
    assert.match(pageHtml, /SANDBOX SIMULATION/);
    assert.match(pageHtml, /View Verified Live PASS/);
    assert.match(pageHtml, /Want the real proof\? This same limit test passed on NWC \+ Lightning\./);

    for (const asset of ["/sandbox/sandbox-runner.js", "/sandbox/sandbox-evidence.js"]) {
      const moduleResponse = await fetch(`${base}${asset}`);
      assert.equal(moduleResponse.status, 200);
      assert.match(moduleResponse.headers.get("content-type"), /javascript/);
    }

    const reportResponse = await fetch(`${base}/reports/phase6.2-final-evidence.json`);
    assert.equal(reportResponse.status, 200);
    assert.match(reportResponse.headers.get("content-disposition"), /^inline;/);
    const servedBytes = Buffer.from(await reportResponse.arrayBuffer());
    const diskBytes = await readFile(new URL("../reports/phase6.2-final-evidence.json", import.meta.url));
    assert.deepEqual(servedBytes, diskBytes);
    assert.equal(createHash("sha256").update(diskBytes).digest("hex").toUpperCase(), "70E2627436878537981215A9CA629588059683739089D3DF588E376209BB48C5");
    const report = JSON.parse(servedBytes.toString("utf8"));
    assert.equal(report.runId, "5519e35b-96c5-4e25-8bbc-668d41dea845");
    assert.equal(report.finalClassification, "PASS");
    assert.equal(report.configuredBudgetSats, 1_000);
    assert.equal(report.requestCount, 2);
    assert.equal(report.dispatchDeltaMs, 1.312);
    assert.equal(report.independentlySettledPrincipalSats, 700);
    assert.equal(report.postRaceBudget.remainingBudgetMsat, 300_000);
    assert.equal(report.invariant.holds, true);
    assert.equal(report.evidenceCompleteness.complete, true);

    const downloadResponse = await fetch(`${base}/reports/phase6.2-final-evidence.json?download=1`);
    assert.match(downloadResponse.headers.get("content-disposition"), /^attachment;/);
    assert.equal((await downloadResponse.json()).finalClassification, "PASS");

    const privatePath = await fetch(`${base}/reports/phase6.2-final-evidence.c39c3771-final.json`);
    assert.equal(privatePath.status, 404);
    const sourcePath = await fetch(`${base}/scripts/phase45-core.mjs`);
    assert.equal(sourcePath.status, 404);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
