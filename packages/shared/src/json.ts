import { z } from 'zod';

/** A JSON-compatible value. Everything persisted in a JSON column or an SSE frame is one of these. */
export type JsonPrimitive = string | number | boolean | null;
// Recursive: a Record<> alias cannot reference itself, an interface can.
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

export const JsonObjectSchema: z.ZodType<JsonObject> = z.lazy(() =>
  z.record(z.string(), JsonValueSchema),
);
