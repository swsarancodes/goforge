import { describe, expect, it } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { buildAiDiagramPreview } from "./ai-diagram-preview";

describe("AI diagram preview", () => {
    it("keeps deleted fields visible and labels every change kind", () => {
        const current = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const target = structuredClone(current);
        const users = target.tables.find((table) => table.id === "users")!;
        const deletedField = users.fields.find((field) => field.name === "status")!;
        users.fields = users.fields.filter((field) => field.id !== deletedField.id);
        const newField = { ...users.fields[0], id: "users.created_at", name: "created_at" };
        users.fields.push(newField);

        const preview = buildAiDiagramPreview(current, target, [
            { type: "DELETE_FIELD", tableId: users.id, fieldId: deletedField.id },
            { type: "CREATE_FIELD", tableId: users.id, field: newField },
        ]);
        const displayUsers = preview.database.tables.find((table) => table.id === users.id)!;

        expect(displayUsers.fields.map((field) => field.name)).toContain("status");
        expect(preview.fieldStatuses[deletedField.id]).toBe("deleted");
        expect(preview.fieldStatuses[newField.id]).toBe("added");
        expect(preview.tableStatuses[users.id]).toBe("modified");
    });
});
