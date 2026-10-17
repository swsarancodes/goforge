import { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { databases } from "./database-schema";

/**
 * A frozen copy of a project's schema at one moment. `content` is a serialized project
 * file and is never rewritten; only the label and note can change. `hash` covers the
 * whole content (so tampering is detectable), `fingerprint` covers only the schema
 * (layout and timestamps excluded) so "has anything changed since?" ignores moving tables.
 */
export const schema_snapshots = sqliteTable("schema_snapshots", {
    id: text("id").primaryKey().notNull().unique(),
    databaseId: text("databaseId").notNull().references(() => databases.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    note: text("note"),
    kind: text("kind", { enum: ["manual", "auto"] }).notNull().default("manual"),
    dialect: text("dialect").notNull(),
    fingerprint: text("fingerprint").notNull(),
    hash: text("hash").notNull(),
    content: text("content").notNull(),
    tableCount: integer("tableCount").notNull().default(0),
    createdAt: text("createdAt"),
});

/**
 * One recorded schema change between two snapshots, with the SQL that performs it (`upSql`)
 * and, when a safe inverse exists, the SQL that undoes it (`downSql`). When no safe inverse
 * exists `downSql` is null and `downBlockedReason` says why.
 */
export const schema_migrations = sqliteTable("schema_migrations", {
    id: text("id").primaryKey().notNull().unique(),
    databaseId: text("databaseId").notNull().references(() => databases.id, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull().default(0),
    name: text("name").notNull(),
    description: text("description"),
    origin: text("origin").notNull().default("manual"),
    sourceSnapshotId: text("sourceSnapshotId").notNull().references(() => schema_snapshots.id, { onDelete: "cascade" }),
    targetSnapshotId: text("targetSnapshotId").notNull().references(() => schema_snapshots.id, { onDelete: "cascade" }),
    upSql: text("upSql").notNull(),
    downSql: text("downSql"),
    downBlockedReason: text("downBlockedReason"),
    checksum: text("checksum").notNull(),
    dialect: text("dialect").notNull(),
    createdAt: text("createdAt"),
});

export interface SnapshotType extends InferSelectModel<typeof schema_snapshots> {}
export interface SnapshotInsertType extends InferInsertModel<typeof schema_snapshots> {}
export interface MigrationType extends InferSelectModel<typeof schema_migrations> {}
export interface MigrationInsertType extends InferInsertModel<typeof schema_migrations> {}
