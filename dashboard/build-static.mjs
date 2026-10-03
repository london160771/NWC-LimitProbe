import { copyFile, lstat, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDirectory = resolve(projectDirectory, "dist");
const reportPath = "reports/phase6.2-final-evidence.json";
const publicFiles = [
  "dashboard/index.html",
  "dashboard/favicon.svg",
  "dashboard/dashboard.css",
  "dashboard/dashboard.js",
  "dashboard/docs.html",
  "dashboard/docs.css",
  "dashboard/sandbox/sandbox-runner.js",
  "dashboard/sandbox/sandbox-evidence.js",
  reportPath,
];
const forbiddenValuePatterns = [
  /nostr\+walletconnect:\/\//i,
  /\b(?:lnbcrt|lntb|lnbc)[0-9a-z]{20,}\b/i,
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9_-])/,
];
const forbiddenFieldNames = new Set([
  "nwcUri", "nostrWalletConnectUrl", "bolt11", "invoiceString", "preimage",
  "password", "token", "macaroon", "rpcUser", "rpcPassword", "tlsKey",
  "tlsCert", "privateKey", "seedPhrase",
].map((name) => name.toLowerCase()));

function assertNoSecrets(text, sourceName) {
  if (forbiddenValuePatterns.some((pattern) => pattern.test(text))) {
    throw new Error(`Secret-shaped value found in public asset: ${sourceName}`);
  }
}

function assertReportIsExpectedAndRedacted(reportText) {
  assertNoSecrets(reportText, reportPath);
  const report = JSON.parse(reportText);
  if (report?.runId !== "5519e35b-96c5-4e25-8bbc-668d41dea845"
    || report?.finalClassification !== "PASS"
    || report?.network !== "regtest"
    || report?.evidenceCompleteness?.complete !== true) {
    throw new Error("Committed verified evidence is missing or does not match the expected PASS run.");
  }

  const inspectFields = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) inspectFields(item);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (forbiddenFieldNames.has(key.toLowerCase())) {
          throw new Error(`Sensitive field found in public evidence: ${key}`);
        }
        inspectFields(child);
      }
    }
  };
  inspectFields(report);
}

async function inspectExistingOutput(outputDirectory, allowedFiles) {
  let rootStat;
  try {
    rootStat = await lstat(outputDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Static output path must be a real directory.");
  }

  const allowedDirectories = new Set();
  for (const file of allowedFiles) {
    let parent = dirname(file).replaceAll("\\", "/");
    while (parent !== ".") {
      allowedDirectories.add(parent);
      parent = dirname(parent);
    }
  }
  const walk = async (directory, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("Static output cannot contain symbolic links.");
      if (entry.isDirectory()) {
        if (!allowedDirectories.has(path)) throw new Error(`Unexpected directory in static output: ${path}`);
        await walk(resolve(directory, entry.name), path);
      } else if (!entry.isFile() || !allowedFiles.has(path)) {
        throw new Error(`Unexpected file in static output: ${path}`);
      }
    }
  };
  await walk(outputDirectory);
}

/** Copy only the explicitly public dashboard files into an isolated static output. */
export async function buildStaticSite(outputDirectory = defaultOutputDirectory) {
  const target = resolve(outputDirectory);
  const relativeTarget = relative(projectDirectory, target);
  const relativeTempTarget = relative(resolve(tmpdir()), target);
  const isProjectDist = relativeTarget === "dist" || relativeTarget.startsWith(`dist${sep}`);
  const isTemporaryTestOutput = target.split(/[\\/]/).at(-1) === "dist"
    && relativeTempTarget !== ".." && !relativeTempTarget.startsWith(`..${sep}`) && relativeTempTarget !== "";
  if (!isProjectDist && !isTemporaryTestOutput) {
    throw new Error("Static output must be inside the project dist directory.");
  }

  const assets = await Promise.all(publicFiles.map(async (source) => ({
    source,
    contents: await readFile(resolve(projectDirectory, source)),
  })));
  const report = assets.find((asset) => asset.source === reportPath);
  assertReportIsExpectedAndRedacted(report.contents.toString("utf8"));
  for (const asset of assets) {
    if (asset.source !== reportPath) assertNoSecrets(asset.contents.toString("utf8"), asset.source);
  }

  const allowedFiles = new Set(publicFiles.map((source) => source.replace(/^dashboard\//, "")));
  await mkdir(target, { recursive: true });
  await inspectExistingOutput(target, allowedFiles);
  for (const asset of assets) {
    const relativeTargetPath = asset.source.replace(/^dashboard\//, "");
    const destination = resolve(target, relativeTargetPath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolve(projectDirectory, asset.source), destination);
  }
  await inspectExistingOutput(target, allowedFiles);

  return { outputDirectory: target, files: [...allowedFiles].sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await buildStaticSite();
    process.stdout.write(`LimitProbe static site built (${result.files.length} public files).\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Static site build failed."}\n`);
    process.exitCode = 1;
  }
}
