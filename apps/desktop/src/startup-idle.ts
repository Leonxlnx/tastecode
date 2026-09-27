/** Measure idle memory only after startup RPCs finish and their UI commits settle.
 * New work cancels the quiet delay; work during capture invalidates the result. */
export class StartupIdleGate {
  #ready = false
  #idle = false
  #started = false
  #interrupted = false
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private delayMs: number,
    private capture: () => void,
  ) {}

  get interrupted(): boolean {
    return this.#interrupted
  }

  ready(): void {
    this.#ready = true
    this.#schedule()
  }

  setIdle(idle: boolean): void {
    this.#idle = idle
    if (!idle) {
      clearTimeout(this.#timer)
      this.#timer = undefined
      if (this.#started) this.#interrupted = true
    }
    this.#schedule()
  }

  #schedule(): void {
    if (!this.#ready || !this.#idle || this.#started || this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#started = true
      this.capture()
    }, this.delayMs)
  }
}
