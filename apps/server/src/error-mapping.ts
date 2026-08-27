export function mapServerError(
  error: Error,
  secrets: string[],
): { code: string; status: number; message: string; retryable: boolean } {
  let message = error.message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
  for (const secret of secrets) message = message.split(secret).join("[REDACTED]");
  const schemaMismatch = /schema_mismatch|unsupported database schema/i.test(error.message);
  const databaseFailure = /SQLITE_|constraint failed|database is locked|database disk image/i.test(
    error.message,
  );
  const notFound = /not found/i.test(error.message);
  const conflict =
    /(already|not pending|not cancellable|active run|only interrupted|requiring confirmation)/i.test(
      error.message,
    );
  const providerContract = /provider contract/i.test(error.message);
  const provider =
    !providerContract && /(provider|preflight|classification|verification|model)/i.test(error.message);
  const cancelled = /cancel/i.test(error.message);
  const forbidden = /administrator access|required permission|forbidden|grant expired|grant missing/i.test(
    error.message,
  );
  const validation =
    /(invalid|required|must |unsupported|outside|escapes|exceeds|unavailable|does not support|belongs to another session)/i.test(
      error.message,
    );
  const code = schemaMismatch
    ? "schema_mismatch"
    : databaseFailure
      ? "database_error"
      : notFound
        ? "not_found"
        : conflict
          ? "conflict"
          : forbidden
            ? "forbidden"
            : providerContract
              ? "provider_contract_error"
              : cancelled
                ? "cancelled"
                : provider
                  ? "provider_error"
                  : validation
                    ? "validation_failed"
                    : "internal_error";
  const status = schemaMismatch
    ? 503
    : notFound
      ? 404
      : conflict || cancelled
        ? 409
        : forbidden
          ? 403
          : providerContract || provider
            ? 502
            : validation
              ? 400
              : 500;
  if (schemaMismatch) message = "Server state does not match this release; reset state explicitly.";
  else if (databaseFailure)
    message = "The server could not persist this operation. Retry after checking server state.";
  return {
    code,
    status: databaseFailure && !schemaMismatch ? 500 : status,
    message,
    retryable: provider || databaseFailure || code === "internal_error",
  };
}
