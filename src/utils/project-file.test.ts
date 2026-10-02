import { describe, expect, it } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { getDataTypes } from "@/test/fixtures/data-types";
import {
    PROJECT_FILE_FORMAT,
    PROJECT_FILE_VERSION,
    ProjectFileError,
    parseProjectFile,
    projectToBundle,
    serializeProject,
    summarizeProject,
} from "./project-file";

const sample = () => ({ ...buildSampleDatabase(DatabaseDialect.POSTGRES), id: "db1", name: "Shop" }) as any;
const roundTrip = () => JSON.stringify(serializeProject(sample(), new Date("2026-01-01T00:00:00Z")));

describe("project file", () => {
    it("serializes plain rows with a format header", () => {
        const file = serializeProject(sample(), new Date("2026-01-01T00:00:00Z"));
        expect(file.format).toBe(PROJECT_FILE_FORMAT);
        expect(file.formatVersion).toBe(PROJECT_FILE_VERSION);
        expect(file.project.name).toBe("Shop");
        expect(file.project.tables.map((table) => table.name).sort()).toEqual(["posts", "users"]);
        const serialized = JSON.stringify(file);
        // Joined helper objects must not leak into the file.
        expect(serialized).not.toContain('"sourceTable"');
        expect(serialized).not.toContain('"databaseId"');
    });

    it("parses what it serializes and preserves counts", () => {
        const parsed = parseProjectFile(roundTrip());
        const summary = summarizeProject(parsed);
        expect(summary.tables).toBe(2);
        expect(summary.relationships).toBe(1);
        expect(summary.fields).toBeGreaterThan(2);
    });

    it("accepts known type ids and rejects unknown ones", () => {
        const known = new Set(getDataTypes(DatabaseDialect.POSTGRES).map((type) => type.id as string));
        expect(() => parseProjectFile(roundTrip(), known)).not.toThrow();
        expect(() => parseProjectFile(roundTrip(), new Set(["nope"]))).toThrow(ProjectFileError);
    });

    it("rejects non-JSON and foreign JSON", () => {
        expect(() => parseProjectFile("not json")).toThrow("not valid JSON");
        expect(() => parseProjectFile("{}")).toThrow("not a GoForge project file");
        expect(() => parseProjectFile("[]")).toThrow("not a GoForge project file");
    });

    it("rejects files from a newer format version", () => {
        const doc = JSON.parse(roundTrip());
        doc.formatVersion = PROJECT_FILE_VERSION + 1;
        expect(() => parseProjectFile(JSON.stringify(doc))).toThrow("newer version");
    });

    it("reports dangling references", () => {
        const doc = JSON.parse(roundTrip());
        doc.project.relationships[0].targetFieldId = "ghost";
        try {
            parseProjectFile(JSON.stringify(doc));
            throw new Error("expected failure");
        } catch (error) {
            expect(error).toBeInstanceOf(ProjectFileError);
            expect((error as ProjectFileError).details.join("\n")).toContain("targetFieldId references an unknown field");
        }
    });

    it("rejects duplicate ids and unsupported dialects", () => {
        const dup = JSON.parse(roundTrip());
        dup.project.tables[1].id = dup.project.tables[0].id;
        expect(() => parseProjectFile(JSON.stringify(dup))).toThrow(ProjectFileError);

        const bad = JSON.parse(roundTrip());
        bad.project.dialect = "mongodb";
        expect(() => parseProjectFile(JSON.stringify(bad))).toThrow(ProjectFileError);
    });

    it("remaps every id and keeps cross references consistent", () => {
        let counter = 0;
        const file = parseProjectFile(roundTrip());
        const bundle = projectToBundle(file, () => `new-${++counter}`, "Shop (copy)");

        expect(bundle.name).toBe("Shop (copy)");
        const oldIds = new Set<string>();
        file.project.tables.forEach((table) => {
            oldIds.add(table.id);
            table.fields.forEach((field) => oldIds.add(field.id));
        });
        const newTableIds = new Set(bundle.tables.map((table) => table.id));
        const newFieldIds = new Set(bundle.tables.flatMap((table) => table.fields.map((field) => field.id as string)));
        for (const id of [...newTableIds, ...newFieldIds]) {
            expect(oldIds.has(id)).toBe(false);
            expect(id.startsWith("new-")).toBe(true);
        }
        for (const table of bundle.tables) {
            for (const field of table.fields) expect(field.tableId).toBe(table.id);
        }
        for (const relationship of bundle.relationships) {
            expect(newTableIds.has(relationship.sourceTableId)).toBe(true);
            expect(newTableIds.has(relationship.targetTableId)).toBe(true);
            expect(newFieldIds.has(relationship.sourceFieldId)).toBe(true);
            expect(newFieldIds.has(relationship.targetFieldId)).toBe(true);
        }
        // Type ids refer to the shared data-type catalogue and must survive untouched.
        const originalTypeIds = file.project.tables.flatMap((table) => table.fields.map((field) => field.typeId));
        const newTypeIds = bundle.tables.flatMap((table) => table.fields.map((field) => field.typeId));
        expect(newTypeIds).toEqual(originalTypeIds);
    });

    it("importing the same file twice produces disjoint ids", () => {
        const file = parseProjectFile(roundTrip());
        let counter = 0;
        const next = () => `id-${++counter}`;
        const a = projectToBundle(file, next);
        const b = projectToBundle(file, next);
        const idsA = new Set(a.tables.map((table) => table.id));
        expect(b.tables.some((table) => idsA.has(table.id))).toBe(false);
    });

    describe("check constraints", () => {
        const withChecks = () => {
            const database = sample();
            database.tables[0].checks = [
                { id: "c1", tableId: database.tables[0].id, name: "chk_one", expression: "id > 0", createdAt: "2026-01-01T00:00:00.000Z" },
                { id: "c2", tableId: database.tables[0].id, name: "chk_two", expression: "id < 1000", createdAt: "2026-01-01T00:00:00.000Z" },
            ];
            return JSON.stringify(serializeProject(database, new Date("2026-01-01T00:00:00Z")));
        };

        it("round-trips through the file with new ids and the right table", () => {
            const file = parseProjectFile(withChecks());
            expect(summarizeProject(file).checks).toBe(2);
            let counter = 0;
            const bundle = projectToBundle(file, () => `n-${++counter}`);
            const table = bundle.tables.find((candidate) => candidate.checks.length === 2)!;
            expect(table.checks.map((check) => check.name)).toEqual(["chk_one", "chk_two"]);
            expect(table.checks.every((check) => check.tableId === table.id)).toBe(true);
            expect(table.checks.map((check) => check.id)).not.toContain("c1");
        });

        it("accepts files that predate check constraints", () => {
            const doc = JSON.parse(roundTrip());
            for (const table of doc.project.tables) delete table.checks;
            const file = parseProjectFile(JSON.stringify(doc));
            expect(summarizeProject(file).checks).toBe(0);
            expect(projectToBundle(file, () => Math.random().toString()).tables.every((table) => table.checks.length === 0)).toBe(true);
        });

        it("rejects expressions the editor would refuse", () => {
            const doc = JSON.parse(withChecks());
            doc.project.tables[0].checks[0].expression = "1=1); DROP TABLE users; --";
            expect(() => parseProjectFile(JSON.stringify(doc))).toThrow(ProjectFileError);
        });

        it("rejects duplicate check names on one table", () => {
            const doc = JSON.parse(withChecks());
            doc.project.tables[0].checks[1].name = "CHK_ONE";
            expect(() => parseProjectFile(JSON.stringify(doc))).toThrow(ProjectFileError);
        });
    });
});
