import { parseArgs } from "node:util";
import { sanitizeReceiverObservation, safeErrorCode } from "./phase45-core.mjs";

const { values } = parseArgs({
  options: {
    "run-id": { type: "string", short: "r" },
    id: { type: "string", short: "i" },
    hash: { type: "string", short: "h" },
    amount: { type: "string", short: "a" },
  },
  allowPositionals: false,
});
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let lookup = null;
let errorCode = null;
let parseFailed = false;
try {
  lookup = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  errorCode = safeErrorCode("OTHER");
  parseFailed = true;
}
if (!parseFailed && lookup && typeof lookup === "object" && (lookup.error != null || lookup.code != null)) {
  errorCode = safeErrorCode(lookup.error?.code ?? lookup.code);
}
const observation = sanitizeReceiverObservation({
  runId: values["run-id"],
  id: values.id,
  requestedHash: values.hash,
  expectedAmountSat: values.amount,
  lookup,
  observedAt: new Date().toISOString(),
});
observation.errorCode = errorCode;
observation.recordType = "receiver_observation";
process.stdout.write(`${JSON.stringify(observation)}\n`);
