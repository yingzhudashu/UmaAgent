import Type from "typebox";

export const PROTOCOL_VERSION = 15 as const;
export const Id = Type.String({ minLength: 1, maxLength: 128 });
export const Timestamp = Type.Integer({ minimum: 0 });
export const Strict = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
