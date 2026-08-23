import { AiSchemaContext, AiSchemaPlanResponse } from "@/lib/ai-schema";

class AiApiError extends Error {
    constructor(message: string, public status: number) {
        super(message);
        this.name = "AiApiError";
    }
}

export async function requestAiSchemaPlan(context: AiSchemaContext): Promise<AiSchemaPlanResponse> {
    const response = await fetch("/api/ai/schema-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
    });

    if (!response.ok) {
        let message = response.statusText;
        try {
            const body = await response.json();
            message = typeof body?.error === "string" ? body.error : message;
            const fieldErrors = body?.details?.fieldErrors;
            if (fieldErrors && typeof fieldErrors === "object") {
                const details = Object.values(fieldErrors)
                    .flatMap((value) => Array.isArray(value) ? value : [])
                    .filter((value): value is string => typeof value === "string")
                    .slice(0, 3);
                if (details.length > 0) message = `${message}: ${details.join("; ")}`;
            }
        } catch {
            // Keep the HTTP status text when the response body is not JSON.
        }
        throw new AiApiError(message || "AI schema planning failed", response.status);
    }

    return response.json() as Promise<AiSchemaPlanResponse>;
}
