import { z } from "zod";

/**
 * Structured outputs: the model is handed a JSON schema and must answer in exactly that shape. The schema comes from our own zod
 * validators, so there is one description of an answer, not two. OpenAI's strict mode is narrower than zod though: every property is
 * required (so "optional" becomes "may be null"), there are no refinements or transforms, and limits such as string length are left
 * to us. `forModel` turns a validator into what the model is shown; the validator itself still checks whatever comes back.
 */

const kind = z.ZodFirstPartyTypeKind;

const nullable = (schema: z.ZodTypeAny): z.ZodTypeAny => (schema instanceof z.ZodNullable ? schema : schema.nullable());

/**
 * The strict-mode form of a validator: objects keep their keys (all required), optional and defaulted fields stay in the answer but may
 * be null, refinements, preprocessing and `.catch` are looked through, and length and size limits are dropped. Throws for a construct it
 * cannot express, so a new kind of field is noticed in a test rather than by a failed request.
 */
export function forModel(schema: z.ZodTypeAny): z.ZodTypeAny {
    const def = schema._def as { typeName?: string; [key: string]: any };
    switch (def.typeName) {
        case kind.ZodObject:
            return z.object(Object.fromEntries(Object.entries((schema as z.AnyZodObject).shape).map(([key, value]) => [key, forModel(value as z.ZodTypeAny)])));
        case kind.ZodString:
            return z.string();
        case kind.ZodNumber:
            return (def.checks as { kind: string }[]).some((check) => check.kind === "int") ? z.number().int() : z.number();
        case kind.ZodBoolean:
            return z.boolean();
        case kind.ZodArray:
            return z.array(forModel(def.type));
        case kind.ZodEnum:
            return z.enum(def.values);
        case kind.ZodLiteral:
            return z.literal(def.value);
        case kind.ZodNullable:
            return nullable(forModel(def.innerType));
        case kind.ZodOptional:
            return nullable(forModel(def.innerType));
        case kind.ZodDefault:
        case kind.ZodCatch:
            return forModel(def.innerType);
        case kind.ZodEffects:
            return forModel(def.schema);
        case kind.ZodDiscriminatedUnion:
            return z.discriminatedUnion(def.discriminator, (def.options as z.ZodTypeAny[]).map(forModel) as [z.ZodObject<any>, z.ZodObject<any>, ...z.ZodObject<any>[]]);
        case kind.ZodUnion:
            return z.union((def.options as z.ZodTypeAny[]).map(forModel) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
        default:
            throw new Error(`Structured outputs cannot describe a ${String(def.typeName)} field.`);
    }
}

/**
 * What a strict answer says about "not given". Every key is present in it, so the ones that do not apply arrive as null; they are
 * removed (everywhere in the answer) so the validator sees the same thing it would have seen from an answer that left them out.
 */
export function stripNulls(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripNulls);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([, entry]) => entry !== null)
                .map(([key, entry]) => [key, stripNulls(entry)]),
        );
    }
    return value;
}

/** A schema and the name the API wants for it: what a call passes to ask for a structured answer. */
export interface ResponseFormat {
    name: string;
    /** The validator this answer is checked against afterwards. Not what the model is shown: see `forModel`. */
    schema: z.ZodTypeAny;
}
