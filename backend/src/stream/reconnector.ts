export interface ReconnectorOptions {
  maxAttempts?: number
  baseDelay?: number
  maxDelay?: number
}

export class Reconnector {
  private attempts = 0
  private readonly maxAttempts: number
  private readonly baseDelay: number
  private readonly maxDelay: number

  constructor(options: ReconnectorOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 10
    this.baseDelay = options.baseDelay ?? 1000
    this.maxDelay = options.maxDelay ?? 30_000
  }

  get attemptCount(): number {
    return this.attempts
  }

  reset(): void {
    this.attempts = 0
  }

  async wait(): Promise<void> {
    if (this.attempts >= this.maxAttempts) {
      throw new Error(`Max reconnect attempts (${this.maxAttempts}) exceeded`)
    }

    const delay = Math.min(
      this.baseDelay * Math.pow(2, this.attempts),
      this.maxDelay,
    )

    console.log(
      `[Reconnector] Attempt ${this.attempts + 1}/${this.maxAttempts} in ${delay}ms`,
    )

    this.attempts++
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
  }
}
