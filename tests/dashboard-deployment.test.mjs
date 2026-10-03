import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildStaticSite } from "../dashboard/build-static.mjs";

const expectedReportHash = "70E2627436878537981215A9CA629588059683739089D3DF588E376209BB48C5";

test("Vercel static build contains only public dashboard assets and verified evidence", async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "limitprobe-vercel-"));
  const outputDirectory = join(tempDirectory, "dist");
  try {
    const result = await buildStaticSite(outputDirectory);
    assert.equal(result.files.length, 8);
    assert.deepEqual((await readdir(outputDirectory)).sort(), ["dashboard.css", "dashboard.js", "docs.css", "docs.html", "index.html", "reports", "sandbox"].sort());
    assert.deepEqual((await readdir(join(outputDirectory, "sandbox"))).sort(), ["sandbox-evidence.js", "sandbox-runner.js"]);
    assert.deepEqual((await readdir(join(outputDirectory, "reports"))).sort(), ["phase6.2-final-evidence.json"]);
    for (const forbidden of ["server.mjs", "build-static.mjs", "scripts", "AGENTS.md", "SPEC.md", "DESIGN.md"]) {
      assert.ok(!result.files.includes(forbidden));
    }

    const index = await readFile(join(outputDirectory, "index.html"), "utf8");
    const docs = await readFile(join(outputDirectory, "docs.html"), "utf8");
    const dashboardJs = await readFile(join(outputDirectory, "dashboard.js"), "utf8");
    assert.match(index, /href="\/docs"/);
    assert.match(index, /download/);
    assert.match(index, /Run Sandbox Test/);
    assert.match(docs, /href="\/reports\/phase6\.2-final-evidence\.json"/);
    assert.match(docs, /download/);
    assert.match(dashboardJs, /fetch\("\/reports\/phase6\.2-final-evidence\.json"/);

    const report = await readFile(join(outputDirectory, "reports", "phase6.2-final-evidence.json"));
    assert.equal(createHash("sha256").update(report).digest("hex").toUpperCase(), expectedReportHash);
    assert.equal(JSON.parse(report).runId, "5519e35b-96c5-4e25-8bbc-668d41dea845");
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("static build refuses unexpected files instead of publishing unknown workspace content", async () => {
  const tempDirectory = await mkdtemp(join(tmpdir(), "limitprobe-vercel-"));
  const outputDirectory = join(tempDirectory, "dist");
  try {
    await buildStaticSite(outputDirectory);
    await writeFile(join(outputDirectory, "private-runtime.json"), "{}\n");
    await assert.rejects(buildStaticSite(outputDirectory), /Unexpected file in static output/);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test("Vercel config maps docs.html to the direct /docs route and publishes dist only", async () => {
  const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(config.buildCommand, "node dashboard/build-static.mjs");
  assert.equal(config.outputDirectory, "dist");
  assert.equal(config.cleanUrls, true);
});
