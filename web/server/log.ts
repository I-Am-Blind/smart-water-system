/** Tiny structured logger: [ISO time][TAG] message. */
export function log(tag: string, msg: string, ...rest: unknown[]): void {
  console.log(`[${new Date().toISOString()}][${tag}] ${msg}`, ...rest);
}

export function logError(tag: string, msg: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(`[${new Date().toISOString()}][${tag}] ${msg}: ${detail}`);
}
