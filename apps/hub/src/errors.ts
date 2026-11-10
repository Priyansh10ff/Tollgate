export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);
export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, "bad_request", message, details);

export class InsufficientFundsError extends AppError {
  constructor(accountId: string, balance: number, needed: number) {
    super(402, "insufficient_funds", "Not enough balance for this transaction", {
      accountId,
      balance,
      needed,
    });
  }
}
