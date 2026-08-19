export function mergeWorkerEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return extra ? { ...process.env, ...extra } : { ...process.env };
}
