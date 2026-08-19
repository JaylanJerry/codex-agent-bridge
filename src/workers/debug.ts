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
  if (files && Object.keys(files).length > 0 && !debug) {
    throw new BridgeError(ErrorCodes.WORKER_NOT_ALLOWED, "files is only available in test/dev");
  }
  return worker;
}
