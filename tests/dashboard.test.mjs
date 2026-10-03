import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createDashboardServer } from "../dashboard/server.mjs";

test("dashboard responsive rules cover mobile, tablet, and desktop widths without fixed-width overflow", async () => {
  const css = await readFile(new URL("../dashboard/dashboard.css", import.meta.url), "utf8");
  const docsCss = await readFile(new URL("../dashboard/docs.css", import.meta.url), "utf8");

  // 390px and 430px use the narrow mobile rules; 768px uses the tablet rules;
  // 1440px remains on the unchanged desktop layout.
  assert.match(css, /@media\s*\(max-width:\s*430px\)/);
  assert.match(css, /@media\s*\(max-width:\s*650px\)/);
  assert.match(css, /@media\s*\(max-width:\s*900px\)/);
  assert.match(css, /\.page-shell\s*\{\s*width:\s*min\(1160px,\s*calc\(100%\s*-\s*64px\)\)/);
  assert.match(css, /\.run-id,\s*\.sandbox-run-id\s*\{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(css, /\.button-large\s*\{[^}]*min-height:\s*44px/s);
  assert.match(css, /\.race-board\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.evidence-section\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(docsCss, /@media\s*\(max-width:\s*390px\)/);
  assert.match(docsCss, /\.docs-main\s*\{\s*width:\s*calc\(100%\s*-\s*32px\)/);
  assert.match(docsCss, /\.run-hash\s*\{[^}]*overflow-wrap:\s*anywhere/s);
});

test("dashboard serves the sandbox modules and the unchanged committed live evidence asset", async () => {
  const server = createDashboardServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    // First request is a direct nested-route navigation, as on a browser refresh.
    const docsResponse = await fetch(`${base}/docs`);
    assert.equal(docsResponse.status, 200);
    assert.match(docsResponse.headers.get("content-type"), /text\/html/);
    const docsHtml = await docsResponse.text();
    assert.match(docsHtml, /5519e35b-96c5-4e25-8bbc-668d41dea845/);
    assert.match(docsHtml, /Technology Integration/);
    assert.match(docsHtml, /SANDBOX TEST/);
    assert.match(docsHtml, /VERIFIED LIVE TEST/);
    assert.match(docsHtml, /Does not call NWC, Alby Hub, or Lightning/);
    assert.match(docsHtml, /Real NWC and Lightning payments on regtest/);
    assert.match(docsHtml, /href="\/"[^>]*>Product/);
    assert.match(docsHtml, /href="\/docs"[^>]*>Docs/);

    const refreshedDocs = await fetch(`${base}/docs`);
    assert.equal(refreshedDocs.status, 200);
    assert.match(await refreshedDocs.text(), /Back to Dashboard/);

    const page = await fetch(base);
    assert.equal(page.status, 200);
    const pageHtml = await page.text();
    assert.match(pageHtml, /Can your AI agent/);
    assert.match(pageHtml, /Run Sandbox Test/);
    assert.match(pageHtml, /SANDBOX SIMULATION/);
    assert.match(pageHtml, /View Verified Live PASS/);
    assert.match(pageHtml, /Want the real proof\? This same limit test passed on NWC \+ Lightning\./);
    assert.match(pageHtml, /href="\/docs">Docs/);

    const dashboardCssResponse = await fetch(`${base}/dashboard.css`);
    assert.equal(dashboardCssResponse.status, 200);
    const dashboardCss = await dashboardCssResponse.text();
    assert.match(dashboardCss, /@media\s*\(max-width:\s*650px\)/);
    assert.match(dashboardCss, /@media\s*\(max-width:\s*430px\)/);
    assert.match(dashboardCss, /font-size:\s*clamp\(34px,\s*9\.15vw,\s*39px\)/);
    assert.match(dashboardCss, /\.run-id,\s*\.sandbox-run-id\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    assert.match(dashboardCss, /\.attempt-row,\s*\.attempt-outcome\s*\{\s*min-width:\s*0/s);

    const docsCssResponse = await fetch(`${base}/docs.css`);
    assert.equal(docsCssResponse.status, 200);
    const docsCss = await docsCssResponse.text();
    assert.match(docsCss, /@media\s*\(max-width:\s*680px\)/);
    assert.match(docsCss, /@media\s*\(max-width:\s*390px\)/);
    assert.match(docsCss, /overflow-wrap:\s*anywhere/);

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
    for (const claim of ["1.312 ms", "1,000 sats", "700 + 700 sats", "700 sats", "300 sats", "QUOTA_EXCEEDED"]) {
      assert.ok(docsHtml.includes(claim), `docs should reflect committed evidence claim: ${claim}`);
    }

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
