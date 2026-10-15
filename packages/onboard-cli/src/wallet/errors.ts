/** Public errors carry a code only, never an underlying crypto or JSON error. */
export class WalletError extends Error {
  readonly code: string;
  readonly exitCode: number;
  readonly httpStatus?: number;

  constructor(code: string, exitCode = 1, httpStatus?: number) {
    super(code);
    this.name = "WalletError";
    this.code = code;
    this.exitCode = exitCode;
    this.httpStatus = httpStatus;
  }
}
