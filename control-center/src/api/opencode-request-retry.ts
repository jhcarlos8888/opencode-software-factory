/**
 * Retry only idempotent, read-only OpenCode API requests. A prompt, permission
 * reply, shell action, edit or commit must never be replayed automatically.
 */
export async function retryOpenCodeRead<T>(
  method: string,
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): Promise<T> {
  const maxAttempts = method.toUpperCase() === "GET" ? 3 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = /OpenCode API HTTP (?:429|502|503|504)\b|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|TimeoutError|timeout|aborted/i.test(message);
      if (!transient || attempt === maxAttempts) throw error;
      await sleep(attempt === 1 ? 250 : 750);
    }
  }
  throw new Error("Reintentos de lectura agotados.");
}
