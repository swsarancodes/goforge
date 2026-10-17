import { DatabaseDataContext, DatabaseOperationsContext } from "./database-context";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { db } from "../sync-provider/sync-provider";
import { TableInsertType, tables, TableType } from "@/lib/schemas/table-schema";
import { useQuery } from "@powersync/react";
import { toCompilableQuery } from "@powersync/drizzle-driver";
import { asc, count, desc, eq, inArray, or } from "drizzle-orm";
import { QueryResult } from "@powersync/web";
import { FieldInsertType, fields, FieldType } from "@/lib/schemas/field-schema";
import { RelationshipInsertType, relationships } from "@/lib/schemas/relationship-schema";
import DatabaseHistoryProvider from "../database-history/database-history-provider";
import { DBDiffOperation } from "@/utils/database";
import { DatabaseInsertType, DatabaseType, databases as databaseModel } from "@/lib/schemas/database-schema";
import { getTimestamp, groupBy } from "@/utils/utils";
import { IndexInsertType, indices } from "@/lib/schemas/index-schema";
import { field_indices, FieldIndexInsertType } from "@/lib/schemas/field_index-schema";
import { relationship_fields, validateRelationshipFields, validateRelationshipFieldRows, RelationshipFieldInsertType } from "@/lib/schemas/relationship_field-schema";
import { v4 } from "uuid";
import { DataType } from "@/lib/schemas/data-type-schema";
import { deleteFieldsWithCascade, deleteIndicesWithCascade, deleteTablesWithCascade } from "@/utils/cascade";
import { DatabaseDialect } from "@/lib/database";
import type { ProjectBundle } from "@/utils/project-file";
import { CheckConstraintInsertType, check_constraints, checkConstraintValues, validateCheck } from "@/lib/schemas/check-constraint-schema";
import { ViewInsertType, views as viewsModel } from "@/lib/schemas/view-schema";
import { SequenceInsertType, sequences as sequencesModel } from "@/lib/schemas/sequence-schema";
import { databaseGraph } from "@/lib/database-graph";
import { schema_migrations, schema_snapshots } from "@/lib/schemas/version-history-schema";

const TYPE_ORDER = ["integer", "text", "boolean", "numeric", "time", "enum"] as const;



// Inserts tables (with fields), relationships, indices, views and sequences into
// `databaseId`. Shared by "import SQL into the current project" and "import a whole
// project file as a new project".
const insertSchemaRows = async (
    tx: any,
    databaseId: string,
    importedTables: TableInsertType[],
    importedRelationships: RelationshipInsertType[],
    importedIndices: IndexInsertType[],
    importedViews: ViewInsertType[] = [],
    importedSequences: SequenceInsertType[] = [],
) => {
    const operations: Promise<any>[] = [];
    for (const table of importedTables) {
        operations.push(tx.insert(tables).values({
            ...table,
            databaseId,
            createdAt: table.createdAt || getTimestamp()
        } as TableInsertType));

        if (table.fields && table.fields.length > 0) {
            operations.push(
                tx.insert(fields).values(
                    table.fields.map((field: FieldInsertType) => ({ ...field, tableId: table.id }))
                )
            );
        }
        const tableChecks = checkConstraintValues<CheckConstraintInsertType>(table.checks as any);
        if (tableChecks.length > 0) {
            operations.push(
                tx.insert(check_constraints).values(
                    tableChecks.map((check) => ({ ...check, tableId: table.id, createdAt: check.createdAt || getTimestamp() }))
                )
            );
        }
    }
    for (const relationship of importedRelationships) {
        const relationshipFieldValuesToInsert = validateRelationshipFields(
            relationship.relationshipFields,
            relationship.sourceFieldId,
            relationship.targetFieldId,
        );
        const { relationshipFields: _relationshipFields, ...relationshipRow } = relationship;
        operations.push(tx.insert(relationships).values({
            ...relationshipRow,
            databaseId,
            createdAt: relationship.createdAt || getTimestamp(),
        }));
        if (relationshipFieldValuesToInsert.length > 0) {
            operations.push(tx.insert(relationship_fields).values(
                relationshipFieldValuesToInsert.map((relationshipField) => ({ ...relationshipField, relationshipId: relationship.id }))
            ));
        }
    }

    for (const index of importedIndices) {
        operations.push(tx.insert(indices).values({
            ...index,
            createdAt: index.createdAt ? index.createdAt : getTimestamp()
        }));
        if (index.fieldIndices && index.fieldIndices.length > 0) {
            operations.push(tx.insert(field_indices).values(
                index.fieldIndices.map((fieldIndex: FieldIndexInsertType) => ({ ...fieldIndex, indexId: index.id }))
            ))
        }
    }
    for (const view of importedViews) {
        operations.push(tx.insert(viewsModel).values({
            ...view,
            databaseId,
            createdAt: view.createdAt || getTimestamp(),
        }));
    }
    for (const sequence of importedSequences) {
        operations.push(tx.insert(sequencesModel).values({
            ...sequence,
            databaseId,
            createdAt: sequence.createdAt || getTimestamp(),
        }));
    }
    await Promise.all(operations);
};

interface Props { children: React.ReactNode }

const DatabaseProvider: React.FC<Props> = ({ children }) => {

    const [currentDatabaseId, setCurrentDatabaseId] = useState<string | undefined>(localStorage.getItem("database_id") as string | undefined);
    // Fetch all databases
    const { data: databases = [], isLoading: loadingDatabases } = useQuery(toCompilableQuery(
        db.query.databases.findMany({
            orderBy: desc(databaseModel.createdAt)
        })
    ));

    // Fetch the current database with nested tables, fields, and relationships
    let { data: database = [], isLoading: loadingCurrentDatabase } = useQuery(
        toCompilableQuery(
            db.query.databases.findMany({
                where: (databases, { eq }) => eq(databases.id, currentDatabaseId as string),
                with: databaseGraph
            })
        ), [], { runQueryOnce: false },
    );


    const switchDatabase = useCallback((databaseId: string | undefined) => {
        setCurrentDatabaseId(databaseId);
        if (databaseId)
            localStorage.setItem("database_id", databaseId);
        else
            localStorage.removeItem("database_id")
    }, [])

    // Normalize result to single object
    if (database.length == 1)
        database = database[0] as any;
    else
        database = undefined as any;
 



    // Fetch all data types 
    let { data: data_types = [], isLoading: loadingDataTypes, isFetching: fetchingDatatypes } = useQuery(toCompilableQuery(
        db.query.data_types.findMany({
            where: (data_types, { eq }) => eq(data_types.dialect, (database as any)?.dialect)
        })
    ));

    // orderding data types
    data_types = [...data_types].sort((a, b) => {
        const ia = TYPE_ORDER.indexOf(a.type as any);
        const ib = TYPE_ORDER.indexOf(b.type as any);
        return (ia === -1 ? TYPE_ORDER.length : ia) -
            (ib === -1 ? TYPE_ORDER.length : ib);
    })



    const isLoading: boolean = loadingDataTypes || loadingDatabases || loadingCurrentDatabase;

    const isSwitchingDatabase: boolean = useMemo(() => {
        return currentDatabaseId != (database as any)?.id
    }, [currentDatabaseId, database]);

    // CRUD for database 
    const createDatabase = useCallback(async (database: DatabaseInsertType): Promise<QueryResult> => {
        return await db.insert(databaseModel).values({
            ...database,
            createdAt: getTimestamp()
        });
    }, [db]);

    const editDatabase = useCallback(async (database: DatabaseInsertType): Promise<QueryResult> => {
        return await db.update(databaseModel).set(database).where(eq(databaseModel.id, database.id))
    }, [db]);

    const deleteDatabase = useCallback(async (id: string): Promise<void> => {
        await db.transaction(async (tx) => {
            await tx.delete(viewsModel).where(eq(viewsModel.databaseId, id));
            // Version history belongs to the project; migrations first, they point at snapshots.
            await tx.delete(schema_migrations).where(eq(schema_migrations.databaseId, id));
            await tx.delete(schema_snapshots).where(eq(schema_snapshots.databaseId, id));
            await tx.delete(databaseModel).where(eq(databaseModel.id, id));
        });
    }, [db]);

    const updateDbNumTables = useCallback(async (databaseId: string, tx: any) => {

        const [{ count: numOfTables }] = await tx
            .select({ count: count() })
            .from(tables)
            .where(eq(tables.databaseId, databaseId))


        await tx.update(databaseModel).set({
            numOfTables
        }).where(eq(databaseModel.id, databaseId))
    }, []);

    // CRUD operations for Tables
    const createTable = useCallback(async (table: TableInsertType): Promise<void> => {
        if (currentDatabaseId) {
            await db.transaction(async (tx) => {
                await tx.insert(tables).values({
                    ...table,
                    databaseId: currentDatabaseId,
                    createdAt: table.createdAt || getTimestamp()
                });
                await updateDbNumTables(currentDatabaseId, tx);
                if (table.fields) {
                    await tx.insert(fields).values(
                        table.fields.map((field: FieldInsertType) => ({ ...field, tableId: table.id }))
                    );
                }
                const tableChecks = checkConstraintValues<CheckConstraintInsertType>(table.checks as any);
                if (tableChecks.length > 0) {
                    await tx.insert(check_constraints).values(
                        tableChecks.map((check) => ({ ...check, tableId: table.id, createdAt: check.createdAt || getTimestamp() }))
                    );
                }
            });
        } else {
            throw Error("No Database selected");
        }
    }, [db, currentDatabaseId, database]);

    const editTable = useCallback(async (table: TableInsertType): Promise<QueryResult> => {
        return await db.update(tables).set(table).where(eq(tables.id, table.id));
    }, [db]);

    const deleteTable = useCallback(async (id: string): Promise<void> => {
        if (currentDatabaseId) {
            await db.transaction(async (tx) => {
                await deleteTablesWithCascade([id], tx);
                await updateDbNumTables(currentDatabaseId, tx);
            });
        } else {
            throw Error("No Database selected");
        }

    }, [db, currentDatabaseId]);

    const deleteMultiTables = useCallback(async (ids: string[]): Promise<void> => {
        if (currentDatabaseId) {
            await db.transaction(async (tx) => {
                await deleteTablesWithCascade(ids, tx);
                await updateDbNumTables(currentDatabaseId, tx);
            });
        } else {
            throw Error("No Database selected");
        }

    }, [db, currentDatabaseId]);

    // CRUD operations for Fields
    const createField = useCallback(async (field: FieldInsertType): Promise<QueryResult> => {
        return await db.insert(fields).values(field);
    }, [db]);

    const editField = useCallback(async (field: FieldInsertType): Promise<QueryResult> => {
        return await db.update(fields).set(field).where(eq(fields.id, field.id));
    }, [db]);

    // Delete field and its related relationships
    const deleteField = useCallback(async (id: string): Promise<void> => {
        return await db.transaction(async (tx) => {
            await deleteFieldsWithCascade([id], tx);
        })
    }, [db]);

    // Helper to find a field by table and field ID
    const getField = useCallback((tableId: string, id: string) => {
        const table: TableType | undefined = (database as any).tables.find((table: TableType) => table.id == tableId);
        if (table)
            return table.fields.find((field: FieldType) => field.id == id);
    }, [database])

    // Reorder fields in a table
    const orderTableFields = useCallback(async (fieldsList: FieldType[]): Promise<void> => {
        return await db.transaction(async (tx) => {
            for (let index = 0; index < fieldsList.length; index++) {
                await tx.update(fields).set({
                    sequence: index
                }).where(eq(fields.id, fieldsList[index].id))
            }
        })
    }, [db]);

    // Reorder fields in a table
    const orderTables = useCallback(async (tablesList: TableType[]): Promise<void> => {
        return await db.transaction(async (tx) => {
            for (let index = 0; index < tablesList.length; index++) {
                await tx.update(tables).set({
                    sequence: tablesList.length - index - 1
                }).where(eq(tables.id, tablesList[index].id))
            }
        })
    }, [db]);

    // CRUD operations for indices
    const createIndex = useCallback(async (index: IndexInsertType): Promise<QueryResult> => {
        return await db.insert(indices).values({
            ...index,
            createdAt: index.createdAt ? index.createdAt : getTimestamp()
        });
    }, [db]);


    const deleteIndex = useCallback(async (id: string): Promise<void> => {
        return db.transaction(async (tx) => {
            await deleteIndicesWithCascade([id], tx)
        })
    }, [db])

    const editIndex = useCallback(async (index: IndexInsertType): Promise<QueryResult> => {
        return await db.update(indices).set(index).where(eq(indices.id, index.id));
    }, [db]);

    // CRUD operations for CHECK constraints. Validation lives here (not only in the UI) so
    // no code path can persist an expression that would break the generated DDL.
    const findCheckSiblings = useCallback((tableId: string) => {
        const table = (database as any)?.tables?.find((candidate: TableType) => candidate.id === tableId);
        return table?.checks ?? [];
    }, [database]);

    const createCheck = useCallback(async (check: CheckConstraintInsertType): Promise<QueryResult> => {
        const problem = validateCheck(check, findCheckSiblings(check.tableId));
        if (problem) throw new Error(problem);
        return await db.insert(check_constraints).values({
            ...check,
            name: check.name.trim(),
            expression: check.expression.trim(),
            createdAt: check.createdAt ? check.createdAt : getTimestamp()
        });
    }, [db, findCheckSiblings]);

    const editCheck = useCallback(async (check: CheckConstraintInsertType): Promise<QueryResult> => {
        const problem = validateCheck(check, findCheckSiblings(check.tableId));
        if (problem) throw new Error(problem);
        return await db.update(check_constraints)
            .set({ name: check.name.trim(), expression: check.expression.trim() })
            .where(eq(check_constraints.id, check.id));
    }, [db, findCheckSiblings]);

    const deleteCheck = useCallback(async (id: string): Promise<void> => {
        await db.delete(check_constraints).where(eq(check_constraints.id, id));
    }, [db]);

    const editFieldIndices = useCallback((indexId: string, fieldIds: string[]): Promise<void> => {
        return db.transaction(async (tx) => {
            await tx.delete(field_indices).where(eq(field_indices.indexId, indexId));
            if (fieldIds.length > 0)
                await tx.insert(field_indices).values(fieldIds.map((fieldId: string) => ({
                    id: v4(),
                    fieldId,
                    indexId,
                })))
        })
    }, [db])
    // CRUD operations for Relationships
    const createRelationship = useCallback(async (relationship: RelationshipInsertType): Promise<QueryResult> => {
        if (currentDatabaseId) {
            const relationshipFieldValuesToInsert = validateRelationshipFields(
                relationship.relationshipFields,
                relationship.sourceFieldId,
                relationship.targetFieldId,
            );
            const { relationshipFields: _relationshipFields, ...relationshipRow } = relationship;
            return await db.transaction(async (tx) => {
                const result = await tx.insert(relationships).values({
                    ...relationshipRow,
                    databaseId: currentDatabaseId,
                    createdAt: relationship.createdAt || getTimestamp()
                });
                if (relationshipFieldValuesToInsert.length > 0) {
                    await tx.insert(relationship_fields).values(
                        relationshipFieldValuesToInsert.map((field) => ({ ...field, relationshipId: relationship.id }))
                    );
                }
                return result;
            });
        }
        throw Error("No database selected");
    }, [db, currentDatabaseId]);

    const editRelationship = useCallback(async (relationship: RelationshipInsertType): Promise<QueryResult> => {
        const hasRelationshipFields = Object.prototype.hasOwnProperty.call(relationship, 'relationshipFields');
        const relationshipFieldValuesToInsert = hasRelationshipFields
            ? validateRelationshipFields(relationship.relationshipFields, relationship.sourceFieldId, relationship.targetFieldId)
            : [];
        const { relationshipFields: _relationshipFields, ...relationshipRow } = relationship;
        return await db.transaction(async (tx) => {
            const result = await tx.update(relationships).set(relationshipRow).where(eq(relationships.id, relationship.id));
            if (hasRelationshipFields) {
                await tx.delete(relationship_fields).where(eq(relationship_fields.relationshipId, relationship.id));
                if (relationshipFieldValuesToInsert.length > 0) {
                    await tx.insert(relationship_fields).values(
                        relationshipFieldValuesToInsert.map((field) => ({ ...field, relationshipId: relationship.id }))
                    );
                }
            }
            return result;
        });
    }, [db]);

    const deleteRelationship = useCallback(async (id: string): Promise<QueryResult> => {
        return await db.transaction(async (tx) => {
            await tx.delete(relationship_fields).where(eq(relationship_fields.relationshipId, id));
            return await tx.delete(relationships).where(eq(relationships.id, id));
        });
    }, [db]);

    const deleteMultiRelationships = useCallback(async (ids: string[]): Promise<QueryResult> => {
        return await db.transaction(async (tx) => {
            await tx.delete(relationship_fields).where(inArray(relationship_fields.relationshipId, ids));
            return await tx.delete(relationships).where(inArray(relationships.id, ids));
        });
    }, [db]);

    // Update table positions (for UI layout)
    const updateTablePositions = useCallback(async (tableList: TableInsertType[]): Promise<any> => {
        return await db.transaction(async (tx) => {
            let operations: Promise<any>[] = [];
            for (const table of tableList) {
                operations.push(tx.update(tables).set({
                    posX: (table as any).posX,
                    posY: (table as any).posY
                }).where(eq(tables.id, (table as any).id)))
            }
            return await Promise.all(operations);
        })
    }, [db]);

    // Apply a list of diff operations to sync database
    const executeDbDiffOps = useCallback(async (diffOperations: DBDiffOperation[]) => {
        try {
            await db.transaction(async (tx) => {
                let operations: Promise<any>[] = [];

                for (const operation of diffOperations) {

                    if (operation.type == "RENAME_DATABASE") {
                        if (currentDatabaseId)
                            operations.push(tx.update(databaseModel).set({
                                name: operation.chnages.name
                            }).where(eq(databaseModel.id, currentDatabaseId)));
                    }
                    else if (operation.type == "UPDATE_NUM_TABLES") {
                        if (currentDatabaseId)
                            operations.push(
                                tx.update(databaseModel).set({
                                    numOfTables: operation.value
                                }).where(eq(databaseModel.id, currentDatabaseId))
                            )
                    }

                    else if (operation.type == "CREATE_TABLE") {
                        operations.push(tx.insert(tables).values(operation.table));

                        if (operation.table.fields && Object.values(operation.table.fields).length > 0) {
                            operations.push(
                                tx.insert(fields).values(Object.values(operation.table.fields))
                            );
                        }
                        const createdChecks = checkConstraintValues<CheckConstraintInsertType>(operation.table.checks as any);
                        if (createdChecks.length > 0) {
                            operations.push(
                                tx.insert(check_constraints).values(
                                    createdChecks.map((check) => ({ ...check, tableId: operation.table.id, createdAt: check.createdAt || getTimestamp() }))
                                )
                            );
                        }
                        if (operation.table.indices && Object.values(operation.table.indices).length > 0) {
                            const indexes = Object.values(operation.table.indices);
                            for (const index of indexes) {
                                operations.push(tx.insert(indices).values(index));
                                if (index.fieldIndices && Object.values(index.fieldIndices).length > 0) {
                                    operations.push(tx.insert(field_indices).values(Object.values(index.fieldIndices)));
                                }
                            }
                        }

                    } else if (operation.type === "UPDATE_TABLE") {
                        operations.push(
                            tx.update(tables).set(operation.changes).where(eq(tables.id, operation.tableId))
                        )

                    } else if (operation.type === "DELETE_TABLE") {
                        operations.push(
                            deleteTablesWithCascade([operation.tableId], tx)
                        );


                    } else if (operation.type === "CREATE_FIELD") {
                        operations.push(
                            tx.insert(fields).values(operation.field)
                        );

                    } else if (operation.type === "DELETE_FIELD") {
                        operations.push(
                            deleteFieldsWithCascade([operation.fieldId], tx)
                        )

                    } else if (operation.type === "UPDATE_FIELD") {
                        operations.push(
                            tx.update(fields).set(operation.changes).where(eq(fields.id, operation.fieldId))
                        );

                    } else if (operation.type === "CREATE_RELATIONSHIP") {
                        const relationshipFieldValuesToInsert = validateRelationshipFields(
                            operation.relationship.relationshipFields,
                            operation.relationship.sourceFieldId,
                            operation.relationship.targetFieldId,
                        );
                        const {
                            relationshipFields: _relationshipFields,
                            sourceTable: _sourceTable,
                            targetTable: _targetTable,
                            sourceField: _sourceField,
                            targetField: _targetField,
                            ...relationshipRow
                        } = operation.relationship as any;
                        operations.push(
                            tx.insert(relationships).values(relationshipRow)
                        );
                        if (relationshipFieldValuesToInsert.length > 0) {
                            operations.push(
                                tx.insert(relationship_fields).values(
                                    relationshipFieldValuesToInsert.map((relationshipField) => ({ ...relationshipField, relationshipId: operation.relationship.id }))
                                )
                            );
                        }

                    } else if (operation.type === "DELETE_RELATIONSHIP") {
                        operations.push(
                            tx.delete(relationship_fields).where(eq(relationship_fields.relationshipId, operation.relationshipId))
                        );
                        operations.push(
                            tx.delete(relationships).where(eq(relationships.id, operation.relationshipId))
                        );

                    } else if (operation.type === "UPDATE_RELATIONSHIP") {
                        // relationshipFields isn't a column on `relationships`; pair
                        // mutations are handled by UPDATE_RELATIONSHIP_FIELDS below.
                        const { relationshipFields: _relationshipFields, ...changes } = operation.changes as any;
                        operations.push(
                            tx.update(relationships).set(changes).where(eq(relationships.id, operation.relationshipId))
                        );
                    }
                    else if (operation.type === "UPDATE_RELATIONSHIP_FIELDS") {
                        validateRelationshipFieldRows(operation.create);
                        if (operation.delete.length > 0) {
                            operations.push(tx.delete(relationship_fields).where(inArray(relationship_fields.id, operation.delete)));
                        }
                        if (operation.create.length > 0) {
                            operations.push(tx.insert(relationship_fields).values(
                                operation.create.map((field: RelationshipFieldInsertType) => ({ ...field, relationshipId: operation.relationshipId }))
                            ));
                        }
                        for (const update of operation.update) {
                            operations.push(tx.update(relationship_fields).set(update.changes).where(eq(relationship_fields.id, update.id)));
                        }
                    }
                    else if (operation.type === "CREATE_VIEW") {
                        const { id, name, namespace, materialized, definition, dependencies, note, databaseId, createdAt } = operation.view;
                        operations.push(tx.insert(viewsModel).values({
                            id, name, namespace, materialized, definition, dependencies, note, databaseId, createdAt,
                        }));
                    }
                    else if (operation.type === "DELETE_VIEW") {
                        operations.push(tx.delete(viewsModel).where(eq(viewsModel.id, operation.viewId)));
                    }
                    else if (operation.type === "UPDATE_VIEW") {
                        operations.push(tx.update(viewsModel).set(operation.changes).where(eq(viewsModel.id, operation.viewId)));
                    }
                    else if (operation.type === "CREATE_SEQUENCE") {
                        const { id, name, namespace, definition, note, databaseId, createdAt } = operation.sequence;
                        operations.push(tx.insert(sequencesModel).values({
                            id, name, namespace, definition, note, databaseId, createdAt,
                        }));
                    }
                    else if (operation.type === "DELETE_SEQUENCE") {
                        operations.push(tx.delete(sequencesModel).where(eq(sequencesModel.id, operation.sequenceId)));
                    }
                    else if (operation.type === "UPDATE_SEQUENCE") {
                        operations.push(tx.update(sequencesModel).set(operation.changes).where(eq(sequencesModel.id, operation.sequenceId)));
                    }
                    else if (operation.type == "CREATE_CHECK") {
                        const { id, tableId, name, expression, createdAt } = operation.check;
                        operations.push(tx.insert(check_constraints).values({ id, tableId, name, expression, createdAt: createdAt || getTimestamp() }));
                    }
                    else if (operation.type == "DELETE_CHECK") {
                        operations.push(tx.delete(check_constraints).where(eq(check_constraints.id, operation.checkId)));
                    }
                    else if (operation.type == "UPDATE_CHECK") {
                        operations.push(tx.update(check_constraints).set(operation.changes).where(eq(check_constraints.id, operation.checkId)));
                    }
                    else if (operation.type == "CREATE_INDEX") {
                        operations.push(
                            tx.insert(indices).values(operation.index)
                        );
                        if (operation.index.fieldIndices && Object.values(operation.index.fieldIndices).length > 0)
                            operations.push(
                                tx.insert(field_indices).values(Object.values(operation.index.fieldIndices))
                            );
                    }
                    else if (operation.type == "DELETE_INDEX") {
                        operations.push(
                            deleteIndicesWithCascade([operation.indexId], tx)
                        );
                    }
                    else if (operation.type == "UPDATE_INDEX") {
                        operations.push(
                            tx.update(indices).set(operation.changes).where(eq(indices.id, operation.indexId))
                        );

                    } else if (operation.type == "UPDATE_FIELD_INDICES") {
                        if (operation.delete.length > 0) {
                            operations.push(
                                tx.delete(field_indices).where(inArray(field_indices.id, operation.delete))
                            )
                        }
                        if (operation.create.length > 0) {
                            operations.push(
                                tx.insert(field_indices).values(operation.create)
                            );
                        }
                    }
                }
                return await Promise.all(operations);
            })
        } catch (error) {

            throw error
        }
    }, [db, currentDatabaseId]);

    const getInteger = useCallback(() => {
        return data_types.find((dataType: DataType) => dataType.name == "integer" || (dataType.name == "int" && dataType.dialect == DatabaseDialect.MSSQL));
    }, [data_types]);

    const importDatabase = useCallback(async (importedTables: TableInsertType[], importedRelationships: RelationshipInsertType[], importedIndices: IndexInsertType[], importedViews: ViewInsertType[] = [], importedSequences: SequenceInsertType[] = []) => {
        if (currentDatabaseId) {
            return await db.transaction(async (tx) => {
                await insertSchemaRows(tx, currentDatabaseId, importedTables, importedRelationships, importedIndices, importedViews, importedSequences);
                await updateDbNumTables(currentDatabaseId, tx)
            });
        } else {
            throw Error("no database selected")
        }
    }, [db, currentDatabaseId])

    // Creates a brand new database together with all of its contents in one
    // transaction, so a failed import never leaves an empty project behind.
    const importProject = useCallback(async (bundle: ProjectBundle): Promise<string> => {
        const databaseId = v4();
        await db.transaction(async (tx) => {
            await tx.insert(databaseModel).values({
                id: databaseId,
                name: bundle.name,
                dialect: bundle.dialect as any,
                createdAt: getTimestamp(),
            });
            await insertSchemaRows(tx, databaseId, bundle.tables, bundle.relationships, bundle.indexes, bundle.views, bundle.sequences);
            await updateDbNumTables(databaseId, tx);
        });
        return databaseId;
    }, [db, updateDbNumTables])

    const databaseOpsValue = useMemo(() => ({
        isSwitchingDatabase,
        createDatabase,
        editDatabase,
        deleteDatabase,
        switchDatabase,
        createTable,
        editTable,
        deleteTable,
        updateTablePositions,
        deleteMultiTables,
        createField,
        editField,
        deleteField,
        orderTableFields,
        createRelationship,
        editRelationship,
        deleteRelationship,
        deleteMultiRelationships,
        executeDbDiffOps,
        createIndex,
        editIndex,
        deleteIndex,
        createCheck,
        editCheck,
        deleteCheck,
        editFieldIndices,
        importDatabase,
        importProject,
        data_types,
        getInteger,
        orderTables
    }), [
        isSwitchingDatabase,
        createDatabase,
        editDatabase,
        deleteDatabase,
        createTable,
        editTable,
        deleteTable,
        updateTablePositions,
        deleteMultiTables,
        createField,
        editField,
        deleteField,
        orderTableFields,
        createRelationship,
        editRelationship,
        deleteRelationship,
        deleteMultiRelationships,
        executeDbDiffOps,
        createIndex,
        editIndex,
        deleteIndex,
        createCheck,
        editCheck,
        deleteCheck,
        editFieldIndices,
        importDatabase,
        importProject,
        data_types,
        getInteger,
        orderTables
    ]);
    return (
        <DatabaseDataContext.Provider value={{
            database: database as unknown as DatabaseType,
            currentDatabaseId,
            databases: databases as DatabaseType[],
            isLoading,
            isSwitchingDatabase,

            getField,

        }}>
            <DatabaseOperationsContext.Provider value={databaseOpsValue}>
                <DatabaseHistoryProvider>

                    {children}

                </DatabaseHistoryProvider>
            </DatabaseOperationsContext.Provider>
        </DatabaseDataContext.Provider>
    )
}

export const useDatabase = () => useContext(DatabaseDataContext);
export const useDatabaseOperations = () => useContext(DatabaseOperationsContext);

export default DatabaseProvider;
