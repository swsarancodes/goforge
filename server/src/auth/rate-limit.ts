/** Counts attempts per key in a sliding window, in memory (one API process). Enough to make guessing a password impractical. */
export class AttemptLimiter {
    private readonly attempts = new Map<string, number[]>();

    constructor(
        private readonly max: number,
        private readonly windowMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    /** True when this key has used up its attempts and must wait. */
    isBlocked(key: string): boolean {
        return this.recent(key).length >= this.max;
    }

    /** Seconds until the oldest attempt in the window expires. */
    retryAfterSeconds(key: string): number {
        const [oldest] = this.recent(key);
        return oldest === undefined ? 0 : Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
    }

    fail(key: string): void {
        this.attempts.set(key, [...this.recent(key), this.now()]);
        if (this.attempts.size > 10_000) this.sweep();
    }

    succeed(key: string): void {
        this.attempts.delete(key);
    }

    private recent(key: string): number[] {
        const cutoff = this.now() - this.windowMs;
        const kept = (this.attempts.get(key) ?? []).filter((at) => at > cutoff);
        if (kept.length === 0) this.attempts.delete(key);
        else this.attempts.set(key, kept);
        return kept;
    }

    private sweep(): void {
        for (const key of [...this.attempts.keys()]) this.recent(key);
    }
}
