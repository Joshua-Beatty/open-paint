/** A property schema that breaks a rule of EXT-06 (for example a duplicate key or a bad default). */
export class PropertySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropertySchemaError";
  }
}

/** A value rejected by a property with the `reject` policy (EXT-06A-13). */
export class PropertyValidationError extends Error {
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.name = "PropertyValidationError";
    this.key = key;
  }
}
