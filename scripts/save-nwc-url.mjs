import { chmodSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("usage: node scripts/save-nwc-url.mjs <captured-cli-json> <private-output-file>");
  process.exit(2);
}

const payload = JSON.parse(readFileSync(inputPath, "utf8"));
function collectConnectionUrls(value, found = []) {
  if (typeof value === "string" && value.startsWith("nostr+walletconnect://")) {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const child of value) collectConnectionUrls(child, found);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) collectConnectionUrls(child, found);
  }
  return found;
}

const connectionUrls = collectConnectionUrls(payload);
if (connectionUrls.length !== 1) {
  console.error("Hub CLI output did not contain an NWC connection URL.");
  process.exit(2);
}

writeFileSync(outputPath, `${connectionUrls[0]}\n`, { encoding: "utf8", mode: 0o600 });
chmodSync(outputPath, 0o600);
unlinkSync(inputPath);
process.stdout.write("nwc_url_saved=true; captured_secret_output_removed=true\n");
