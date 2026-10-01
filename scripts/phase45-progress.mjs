import { chmodSync, closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { safeErrorCode } from "./phase45-core.mjs";

export function markPostDispatchFailure(progress, error) {
  progress.stage = "post_dispatch_failure";
  progress.paymentMayHaveBeenDispatched = true;
  progress.failureCode = safeErrorCode(error);
  return progress;
}

export function persistPrivateProgress(path, progress) {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  let fd;
  try {
    fd = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(progress, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
