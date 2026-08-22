import type { StructuredError } from './types';

export class FrogLabelError extends Error {
  readonly structured: StructuredError;
  readonly code: string;

  constructor(structured: StructuredError, options?: ErrorOptions) {
    super(structured.message, options);
    this.name = 'FrogLabelError';
    this.structured = structured;
    this.code = structured.code;
  }
}

export class ValidationError extends FrogLabelError {
  constructor(message: string, detail?: string) {
    super({ code: 'validation_error', message, detail });
    this.name = 'ValidationError';
  }
}

export class IntegrationError extends FrogLabelError {
  constructor(code: string, message: string, options: { detail?: string; repair?: string } = {}) {
    super({ code, message, ...options });
    this.name = 'IntegrationError';
  }
}
