import { InferInsertModel, InferSelectModel, relations } from 'drizzle-orm';
import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';
import { fields, FieldType } from './field-schema';
import { relationships, RelationshipType } from './relationship-schema';
import { databases } from './database-schema';
import { IndexType, indices } from './index-schema';
import { CheckConstraintInsertType, CheckConstraintType, check_constraints } from './check-constraint-schema';

export const tables = sqliteTable('tables', {
    id: text('id')
        .primaryKey()
        .notNull()
        .unique(),

    databaseId: text("databaseId").notNull().references(() => databases.id, { onDelete: "cascade" }),

    name: text('name').notNull(),
    // Optional SQL namespace/schema. `name` remains the unqualified identifier
    // used by the canvas and legacy projects.
    namespace: text('namespace'),
    posX: real('posX').notNull().default(0),
    posY: real('posY').notNull().default(0),

    color: text('color'),
    width: real('width'),
    note: text('note'),
    sequence: integer('sequence').default(0),
    createdAt: text('createdAt'),
});


export const tablesRelations = relations(tables, ({ many, one }) => ({
    fields: many(fields),
    sourceRelations: many(relationships),
    targetRelations: many(relationships),
    database: one(databases, {
        fields: [tables.databaseId],
        references: [databases.id],
    }) , 
    indices : many(indices) , 
    checks : many(check_constraints) ,
    
    
}));



export interface TableType extends InferSelectModel<typeof tables> {
    fields: FieldType[];
    indices : IndexType[] ; 
    // Table-level CHECK constraints. Optional so older snapshots and fixtures stay valid.
    checks? : CheckConstraintType[] ;
    
    sourceRelations? :RelationshipType[] ; 
    targetRelations? : RelationshipType[] ; 
    
    sequence : number ;  
};


export interface TableInsertType extends InferInsertModel<typeof tables> {
    fields?: FieldType[];
    checks?: CheckConstraintInsertType[];
    
};

export function qualifiedTableName(table: Pick<TableType, 'name' | 'namespace'> | Pick<TableInsertType, 'name' | 'namespace'>): string {
    return table.namespace ? `${table.namespace}.${table.name}` : table.name;
}
