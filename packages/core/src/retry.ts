export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  retryAfterMs?: (error: unknown) => number | undefined;
  shouldRetry: (error: unknown) => boolean;
}

export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;

  while (true) {
    attempt += 1;
    try {
      return await operation();
    } catch (error) {
      if (attempt >= options.maxAttempts || !options.shouldRetry(error)) throw error;
      const retryAfter = options.retryAfterMs?.(error);
      const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      const jittered = Math.floor(exponential * (0.5 + random() * 0.5));
      await sleep(retryAfter ?? jittered);
    }
  }
}
