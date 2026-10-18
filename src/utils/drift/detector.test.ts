import { describe, it, expect } from "vitest";
import { cloneDeep } from "lodash";
import { DatabaseDialect } from "@/lib/database";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { getDataTypes } from "@/test/fixtures/data-types";
import { getRenderer } from "@/utils/render/render-uttils";
import { detectDrift, buildReconciliationPlan } from "./detector";
import { TableType } from "@/lib/schemas/table-schema";
import { FieldType } from "@/lib/schemas/field-schema";
import { IndexType } from "@/lib/schemas/index-schema";

describe("Phase 5 — Live Database Drift Detection", () => {
    it("reports inSync: true when canvas and live database are identical", () => {
        const canvas = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const live = cloneDeep(canvas);

        const report = detectDrift(canvas, live);
        expect(report.summary.inSync).toBe(true);
        expect(report.items).toHaveLength(0);
    });

    it("detects tables added in live database", () => {
        const canvas = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const live = cloneDeep(canvas);

        const newTable: TableType = {
            id: "t_logs",
            databaseId: live.id,
            name: "audit_logs",
            namespace: null,
            fields: [
                {
                    id: "f_log_id",
                    tableId: "t_logs",
                    name: "id",
                    isPrimary: true,
                    unique: true,
                    nullable: false,
                    typeId: live.tables[0].fields[0].typeId,
                    type: live.tables[0].fields[0].type,
                    defaultValue: null,
                    sequence: 0,
                } as FieldType,
            ],
            indices: [],
        } as any;
        live.tables.push(newTable);

        const report = detectDrift(canvas, live);
        expect(report.summary.inSync).toBe(false);
        expect(report.summary.addedInLive).toBe(1);

        const item = report.items.find(i => i.targetName === "audit_logs");
        expect(item).toBeDefined();
        expect(item?.status).toBe("added_in_live");
    });

    it("detects tables removed in live database", () => {
        const canvas = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const live = cloneDeep(canvas);
        live.tables = live.tables.filter(t => t.name !== "posts");

        const report = detectDrift(canvas, live);
        expect(report.summary.removedInLive).toBe(1);

        const item = report.items.find(i => i.targetName === "posts");
        expect(item).toBeDefined();
        expect(item?.status).toBe("removed_in_live");
    });

    it("detects column additions, removals, and type/nullability modifications", () => {
        const canvas = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const live = cloneDeep(canvas);

        const liveUsers = live.tables.find(t => t.name === "users")!;
        // Remote addition
        liveUsers.fields.push({
            id: "f_phone",
            tableId: liveUsers.id,
            name: "phone_number",
            isPrimary: false,
            unique: false,
            nullable: true,
            typeId: liveUsers.fields[0].typeId,
            type: { name: "varchar" } as any,
            sequence: 4,
        } as any);

        // Remote modification
        const emailField = liveUsers.fields.find(f => f.name === "email")!;
        emailField.nullable = true; // Was false on canvas

        const report = detectDrift(canvas, live);
        const addCol = report.items.find(i => i.targetName === "users.phone_number");
        expect(addCol).toBeDefined();
        expect(addCol?.status).toBe("added_in_live");

        const modCol = report.items.find(i => i.targetName === "users.email");
        expect(modCol).toBeDefined();
        expect(modCol?.status).toBe("modified");
        expect(modCol?.details).toContain("Nullable");
    });

    it("detects remote indexes added or removed", () => {
        const canvas = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const live = cloneDeep(canvas);
        const liveUsers = live.tables.find(t => t.name === "users")!;

        liveUsers.indices = [
            {
                id: "idx_live_remote",
                tableId: liveUsers.id,
                name: "idx_users_remote_test",
                unique: false,
                fieldIndices: [{ id: "fi_1", indexId: "idx_live_remote", fieldId: liveUsers.fields[0].id } as any],
            } as any,
        ];

        const report = detectDrift(canvas, live);
        const idxItem = report.items.find(i => i.targetName === "users.idx_users_remote_test");
        expect(idxItem).toBeDefined();
        expect(idxItem?.category).toBe("index");
        expect(idxItem?.status).toBe("added_in_live");
    });

    it("builds reconciliation plan without mutating canvas or live DB before confirmation", async () => {
        const canvas = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const live = cloneDeep(canvas);
        const liveUsers = live.tables.find(t => t.name === "users")!;
        liveUsers.fields.push({
            id: "f_new",
            tableId: liveUsers.id,
            name: "new_remote_col",
            isPrimary: false,
            unique: false,
            nullable: true,
            typeId: liveUsers.fields[0].typeId,
            type: liveUsers.fields[0].type,
            sequence: 5,
        } as any);

        const report = detectDrift(canvas, live, "pull");
        expect(report.items[0].resolution).toBe("pull");

        const dataTypes = getDataTypes(DatabaseDialect.POSTGRES);
        const renderer = getRenderer(DatabaseDialect.POSTGRES, dataTypes);

        const plan = await buildReconciliationPlan(report, canvas, live, renderer);
        expect(plan.pullCount).toBe(1);
        expect(plan.pushCount).toBe(0);
        // Canvas is NOT mutated yet!
        expect(canvas.tables.find(t => t.name === "users")?.fields.some(f => f.name === "new_remote_col")).toBe(false);
    });
});
