/** The request may have run on the computer before the link dropped. */
export class IndeterminateError extends Error {
  override name = 'IndeterminateError'
}

export class ServerError extends Error {
  override name = 'ServerError'
  constructor(
    message: string,
    readonly code: string | undefined,
  ) {
    super(message)
  }
}
