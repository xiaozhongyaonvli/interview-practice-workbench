// Domain-level error types. Storage and API layers throw these so callers can
// distinguish user-fixable input problems (ValidationError) from infrastructure
// problems (StorageError) without parsing error messages.
//
// Both errors carry a `code` field. UI layers should map `code` to a localized
// message; do not show `error.message` directly to end users.

export class ValidationError extends Error {
  constructor(message, { code = "VALIDATION_FAILED", path = null, value = undefined } = {}) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.path = path;
    if (value !== undefined) {
      this.value = value;
    }
  }
}

export class StorageError extends Error {
  constructor(message, { code = "STORAGE_FAILED", cause = null, path = null } = {}) {
    super(message);
    this.name = "StorageError";
    this.code = code;
    this.path = path;
    if (cause) {
      this.cause = cause;
    }
  }
}
