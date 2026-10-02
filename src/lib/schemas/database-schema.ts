import { InferInsertModel, InferSelectModel, relations } from 'drizzle-orm';
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { tables, TableType } from './table-schema';
import { relationships, RelationshipType } from './relationship-schema';
import { DatabaseDialect } from '../database';
import type { ViewType } from './view-schema';
import { views } from './view-schema';
import type { SequenceType } from './sequence-schema';
import { sequences } from './sequence-schema';


export const databases = sqliteTable('databases', {
    id: text('id')
        .primaryKey()
        .notNull()
        .unique(),
        
    name: text('name').notNull(),

    dialect: text("dialect", {
        enum: ["postgres", "mysql", "sqlite", "mariadb", "mssql", "oracle"],
    }).notNull().default("postgres"),

    numOfTables: integer("numOfTables")
        .notNull()
        .default(0),
    createdAt: text('createdAt'),
});

export const databaseRelations = relations(databases, ({ many }) => ({
    tables: many(tables),
    relationships: many(relationships),
    views: many(views),
    sequences: many(sequences),
   
}));


export interface DatabaseType extends InferSelectModel<typeof databases> {
    tables: TableType[],
    relationships: RelationshipType[];
    views?: ViewType[];
    sequences?: SequenceType[];
    dialect: DatabaseDialect
};
export interface DatabaseInsertType extends InferInsertModel<typeof databases> { };
