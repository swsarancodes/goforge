import { describe, expect, it } from "vitest";
import { compare } from "fast-json-patch";
import { cloneDeep } from "lodash";

import { DatabaseDialect } from "@/lib/database";
import { buildSampleDatabase } from "@/test/fixtures/database";
import { RelationshipFieldType, validateRelationshipFields } from "@/lib/schemas/relationship_field-schema";
import { mapDiffToDBDiffOperation, normalizeDatabase } from "@/utils/database";
import { ViewType } from "@/lib/schemas/view-schema";
import { SequenceType } from "@/lib/schemas/sequence-schema";

describe("composite relationship persistence model", () => {
    it("maps added and edited composite pairs to child-row operations", () => {
        const previous = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const current = cloneDeep(previous);
        current.relationships[0].relationshipFields = [{
            id: "rel_posts_users.1",
            relationshipId: "rel_posts_users",
            sourceFieldId: "users.email",
            targetFieldId: "posts.title",
            sequence: 1,
        } as RelationshipFieldType];

        const addedOperations = mapDiffToDBDiffOperation(
            compare(normalizeDatabase(previous), normalizeDatabase(current)),
        );
        expect(addedOperations).toContainEqual(expect.objectContaining({
            type: "UPDATE_RELATIONSHIP_FIELDS",
            relationshipId: "rel_posts_users",
            create: [expect.objectContaining({ id: "rel_posts_users.1" })],
        }));

        const edited = cloneDeep(current);
        edited.relationships[0].relationshipFields![0].sequence = 2;
        const editedOperations = mapDiffToDBDiffOperation(
            compare(normalizeDatabase(current), normalizeDatabase(edited)),
        );
        expect(editedOperations).toContainEqual(expect.objectContaining({
            type: "UPDATE_RELATIONSHIP_FIELDS",
            relationshipId: "rel_posts_users",
            update: [{ id: "rel_posts_users.1", changes: { sequence: 2 } }],
        }));
    });

    it("rejects incomplete or duplicate composite pairs before persistence", () => {
        expect(() => validateRelationshipFields([{
            id: "pair-2",
            sourceFieldId: "users.email",
            targetFieldId: "posts.title",
            sequence: 2,
        } as RelationshipFieldType])).toThrow(/contiguous sequence/i);

        expect(() => validateRelationshipFields([
            { id: "pair-1", sourceFieldId: "users.email", targetFieldId: "posts.title", sequence: 1 },
            { id: "pair-2", sourceFieldId: "users.email", targetFieldId: "posts.slug", sequence: 2 },
        ] as RelationshipFieldType[])).toThrow(/reuse/i);

        expect(() => validateRelationshipFields([
            { id: "pair-1", sourceFieldId: "users.id", targetFieldId: "posts.user_id", sequence: 1 },
        ] as RelationshipFieldType[], "users.id", "posts.user_id")).toThrow(/reuse/i);
    });
});

describe("view diff operations", () => {
    it("tracks view creation, definition edits, and deletion", () => {
        const previous = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const current = cloneDeep(previous);
        const view = {
            id: "view-active-users",
            databaseId: current.id,
            name: "active_users",
            namespace: "reporting",
            materialized: false,
            definition: "SELECT id FROM users",
            dependencies: null,
            note: null,
            createdAt: null,
        } as ViewType;
        current.views = [view];

        const createOperations = mapDiffToDBDiffOperation(
            compare(normalizeDatabase(previous), normalizeDatabase(current)),
        );
        expect(createOperations).toContainEqual(expect.objectContaining({ type: "CREATE_VIEW", view }));

        const edited = cloneDeep(current);
        edited.views![0].definition = "SELECT id, email FROM users";
        const updateOperations = mapDiffToDBDiffOperation(
            compare(normalizeDatabase(current), normalizeDatabase(edited)),
        );
        expect(updateOperations).toContainEqual(expect.objectContaining({
            type: "UPDATE_VIEW",
            viewId: view.id,
            changes: { definition: edited.views![0].definition },
        }));

        const deleteOperations = mapDiffToDBDiffOperation(
            compare(normalizeDatabase(current), normalizeDatabase(previous)),
        );
        expect(deleteOperations).toContainEqual(expect.objectContaining({ type: "DELETE_VIEW", viewId: view.id }));
    });
});

describe("sequence diff operations", () => {
    it("tracks sequence creation, option edits, and deletion", () => {
        const previous = buildSampleDatabase(DatabaseDialect.POSTGRES);
        const current = cloneDeep(previous);
        const sequence = {
            id: "sequence-order",
            databaseId: current.id,
            name: "order_seq",
            namespace: "reporting",
            definition: "START WITH 100 INCREMENT BY 5",
            note: null,
            createdAt: null,
        } as SequenceType;
        current.sequences = [sequence];

        expect(mapDiffToDBDiffOperation(
            compare(normalizeDatabase(previous), normalizeDatabase(current)),
        )).toContainEqual(expect.objectContaining({ type: "CREATE_SEQUENCE", sequence }));

        const edited = cloneDeep(current);
        edited.sequences![0].definition = "START WITH 100 INCREMENT BY 10";
        expect(mapDiffToDBDiffOperation(
            compare(normalizeDatabase(current), normalizeDatabase(edited)),
        )).toContainEqual(expect.objectContaining({
            type: "UPDATE_SEQUENCE",
            sequenceId: sequence.id,
            changes: { definition: edited.sequences![0].definition },
        }));

        expect(mapDiffToDBDiffOperation(
            compare(normalizeDatabase(current), normalizeDatabase(previous)),
        )).toContainEqual(expect.objectContaining({ type: "DELETE_SEQUENCE", sequenceId: sequence.id }));
    });
});
