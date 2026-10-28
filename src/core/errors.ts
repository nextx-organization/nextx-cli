// Exit codes are part of the public contract (docs: /docs/cli#exit-codes). Do not renumber.
export const Exit = {
  ok: 0,
  general: 1,
  usage: 2,
  auth: 3,
  forbidden: 4,
  quota: 5,
  network: 6,
  notConfirmed: 7,
  notFound: 8,
  interrupted: 130,
} as const;

export type ExitCode = (typeof Exit)[keyof typeof Exit];

/** The brand's server does not offer this sign-in method yet. */
export function notYetError(what: string, instead: string): CliError {
  return new CliError(`${what} — ${instead}`, Exit.usage);
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = Exit.general,
    readonly hint?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function isCliError(e: unknown): e is CliError {
  return e instanceof CliError;
}
