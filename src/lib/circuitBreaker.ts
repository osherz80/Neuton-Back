import { env } from '../env.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker for upstream Gemini calls.
 *
 * - Closed: Normal operation, requests pass through.
 * - Open: Too many recent failures, requests fail fast without calling upstream.
 * - Half-open: After reset timeout, allows a single probe request to test if upstream recovered.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly threshold: number;
  private readonly resetTimeoutMs: number;

  constructor(
    threshold = env.CIRCUIT_BREAKER_THRESHOLD,
    resetTimeoutMs = env.CIRCUIT_BREAKER_RESET_MS,
  ) {
    this.threshold = threshold;
    this.resetTimeoutMs = resetTimeoutMs;
  }

  /** Current circuit state. */
  getState(): CircuitState {
    this.maybeTransitionFromOpen();
    return this.state;
  }

  /** Whether requests should be allowed through. */
  canExecute(): boolean {
    return this.getState() !== 'open';
  }

  /** Record a successful call. */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      // Probe succeeded, close the circuit
      this.state = 'closed';
      this.failureCount = 0;
    } else if (this.state === 'closed') {
      // Reset failure count on success in closed state
      this.failureCount = 0;
    }
  }

  /** Record a failed call. */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half-open') {
      // Probe failed, reopen the circuit
      this.state = 'open';
    } else if (this.state === 'closed' && this.failureCount >= this.threshold) {
      // Threshold reached, open the circuit
      this.state = 'open';
    }
  }

  /** Force the circuit open (e.g., for testing or manual intervention). */
  forceOpen(): void {
    this.state = 'open';
    this.lastFailureTime = Date.now();
  }

  /** Force the circuit closed (reset). */
  forceClosed(): void {
    this.state = 'closed';
    this.failureCount = 0;
  }

  private maybeTransitionFromOpen(): void {
    if (this.state === 'open' && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.state = 'half-open';
    }
  }

  /** Get current status for diagnostics. */
  getStatus(): { state: CircuitState; failureCount: number; threshold: number } {
    return {
      state: this.getState(),
      failureCount: this.failureCount,
      threshold: this.threshold,
    };
  }
}

/** Singleton instance shared across the worker process. */
export const geminiCircuitBreaker = new CircuitBreaker();

/**
 * Error thrown when the circuit breaker is open and a call is rejected.
 * This is a permanent error for the current job attempt — the job will be
 * retried by BullMQ (subject to its attempt limit), but the circuit remains
 * open until the reset timeout elapses.
 */
export class CircuitOpenError extends Error {
  constructor(
    public readonly retryAfterMs: number,
  ) {
    super(`Circuit breaker open, retry after ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
  }
}