/** Measure idle memory only after startup RPCs finish and their UI commits settle.
 * New work cancels the quiet delay; work during capture invalidates the result. */
export class StartupIdleGate {
  #ready = false
  #idle = false
  #started = false
  #notices = 0
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
    if (!idle) this.#busy()
    this.#schedule()
  }

  setNoticeVisible(visible: boolean): void {
    this.#notices = Math.max(0, this.#notices + (visible ? 1 : -1))
    if (visible) this.#busy()
    this.#schedule()
  }

  #busy(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#started) this.#interrupted = true
  }

  #schedule(): void {
    if (
      !this.#ready ||
      !this.#idle ||
      this.#notices > 0 ||
      this.#started ||
      this.#timer !== undefined
    )
      return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#started = true
      this.capture()
    }, this.delayMs)
  }
}
