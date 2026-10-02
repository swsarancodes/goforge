import { InferInsertModel, InferSelectModel, relations } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { databases } from "./database-schema";

/** A persisted database sequence and its dialect-specific creation options. */
export const sequences = sqliteTable("sequences", {
    id: text("id").primaryKey().notNull().unique(),
    databaseId: text("databaseId").notNull().references(() => databases.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    namespace: text("namespace"),
    definition: text("definition").notNull().default(""),
    note: text("note"),
    createdAt: text("createdAt"),
});

export const sequenceRelations = relations(sequences, ({ one }) => ({
    database: one(databases, {
        fields: [sequences.databaseId],
        references: [databases.id],
    }),
}));

export interface SequenceType extends InferSelectModel<typeof sequences> {}
export interface SequenceInsertType extends InferInsertModel<typeof sequences> {}
