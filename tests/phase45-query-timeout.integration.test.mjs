import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { HASH_A, RUN_ID } from "./phase61-evidence-fixture.mjs";

const gitBash = ["C:/Program Files/Git/bin/bash.exe", "C:/Program Files (x86)/Git/bin/bash.exe"].find((path) => {
  try { return Boolean((awaitImportStat(path))); } catch { return false; }
});
function awaitImportStat(path) {
  return requireFs.statSync(path);
}
import * as requireFs from "node:fs";

test("receiver query timeout includes a hanging sanitizer stage and persistence", { skip: !gitBash }, () => {
  const directory = mkdtempSync(join(tmpdir(), "limitprobe-query-timeout-"));
  const fakeBin = join(directory, "bin");
  mkdirSync(fakeBin);
  const writeExecutable = (path, source) => {
    writeFileSync(path, source, { encoding: "utf8", mode: 0o700 });
    chmodSync(path, 0o700);
  };
  writeExecutable(join(fakeBin, "id"), "#!/usr/bin/env bash\nprintf '1000\\n'\n");
  writeExecutable(join(fakeBin, "docker"), [
    "#!/usr/bin/env bash",
    "if [[ \"$1\" == exec ]]; then printf '{\\\"r_hash\\\":\\\"'\"$PHASE45_TEST_HASH\"'\\\",\\\"state\\\":\\\"OPEN\\\"}'; exit 0; fi",
    "if [[ \"$1\" == run ]]; then sleep 5; exit 0; fi",
    "exit 2",
  ].join("\n"));
  const journal = join(directory, "journal.jsonl");
  writeFileSync(journal, "", { mode: 0o600 });
  const helper = join(process.cwd(), "scripts", "phase45-query-bob.sh");
  try {
    const start = Date.now();
    const result = spawnSync(gitBash, [
      "-c",
      'timeout --signal=TERM --kill-after=1s 1s bash "$1" "$2" "$3" "$4" "$5" "$6" "$7" "$8"',
      "_", helper, "A", HASH_A, RUN_ID, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", journal, process.cwd(), "node:22-bookworm",
    ], {
      encoding: "utf8",
      timeout: 7_000,
      env: {
        ...process.env,
        PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
        PHASE45_TEST_HASH: HASH_A,
      },
    });
    const elapsed = Date.now() - start;
    assert.equal(result.status, 124);
    assert.ok(elapsed < 4_000, `bounded pipeline took ${elapsed}ms`);
    assert.equal(result.stdout.includes(HASH_A), false);
    assert.equal(result.stderr.includes("OPEN"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a second Phase 6.2 runner cannot acquire the lifecycle lock", { skip: !gitBash }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "limitprobe-run-lock-"));
  const lock = join(directory, "phase62-run.lock");
  const held = spawn(gitBash, ["-c", 'mkdir "$1" || exit 7; printf LOCK_HELD; read -r _; rmdir "$1"', "_", lock], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    let output = "";
    held.stdout.setEncoding("utf8");
    held.stdout.on("data", (chunk) => { output += chunk; });
    const deadline = Date.now() + 3_000;
    while (!output.includes("LOCK_HELD") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(output.includes("LOCK_HELD"));
    const second = spawnSync(gitBash, ["-c", 'mkdir "$1"', "_", lock], { encoding: "utf8", timeout: 2_000 });
    assert.notEqual(second.status, 0);
  } finally {
    held.stdin.write("release\n");
    await Promise.race([once(held, "exit"), new Promise((resolve) => setTimeout(resolve, 1_000))]);
    if (held.exitCode === null) held.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});
