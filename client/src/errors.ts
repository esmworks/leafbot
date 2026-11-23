/** The server answered, but not with success. */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** The answer came from this server with its reason; false for a proxy's error page. */
    public fromServer = true,
  ) {
    super(message);
  }
}

/** A request that got no answer at all: the connection dropped or the server was not there. */
export class NoAnswerError extends Error {
  /** Read by the shared upload retry, which sees this error as "no answer". */
  readonly noAnswer = true;
}
