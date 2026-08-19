import { BridgeError, ErrorCodes } from "../core/errors.ts";

export function debugWorkersAllowed(): boolean {
  return (
    process.env.AGENT_BRIDGE_DEV === "1" ||
    process.env.AGENT_BRIDGE_ALLOW_DEBUG_WORKERS === "1" ||
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.env.npm_lifecycle_event === "test"
  );
}

export function isProductionWorker(workerId: string): boolean {
  return workerId === "claude" || workerId === "deepseek";
}

export function isDebugWorker(workerId: string): boolean {
  return workerId === "replay" || workerId === "fake";
}

export function assertCallableWorker(
  worker: string | undefined,
  files?: Record<string, string>,
  debug = debugWorkersAllowed(),
): string {
  if (!worker) {
    throw new BridgeError(ErrorCodes.WORKER_REQUIRED, "worker must be specified (claude or deepseek)");
  }
  if (isDebugWorker(worker) && !debug) {
    throw new BridgeError(ErrorCodes.WORKER_NOT_ALLOWED, `${worker} is only available in test/dev`);
  }
  if (!isProductionWorker(worker) && !isDebugWorker(worker)) {
    throw new BridgeError(ErrorCodes.WORKER_NOT_ALLOWED, `unknown worker ${worker}`);
  }
  assertFilesAllowed(worker, files, debug);
  return worker;
}

export function assertExecutableWorker(workerId: string, debug = debugWorkersAllowed()): void {
  if (isDebugWorker(workerId) && !debug) {
    throw new BridgeError(ErrorCodes.WORKER_NOT_ALLOWED, `${workerId} is only available in test/dev`);
  }
}

export function assertFilesAllowed(
  workerId: string,
  files?: Record<string, string>,
  debug = debugWorkersAllowed(),
): void {
  if (!files || Object.keys(files).length === 0) return;
  if (!debug || !isDebugWorker(workerId)) {
    throw new BridgeError(
      ErrorCodes.WORKER_NOT_ALLOWED,
      "files is only available for debug workers in test/dev",
    );
  }
}

export function assertInPlaceAllowed(inPlace: boolean | undefined, debug = debugWorkersAllowed()): void {
  if (inPlace && !debug) {
    throw new BridgeError(ErrorCodes.IN_PLACE_NOT_ALLOWED, "inPlace is only available in test/dev");
  }
}
