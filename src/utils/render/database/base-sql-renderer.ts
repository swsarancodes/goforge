import { DatabaseDialect, getDatabaseByDialect } from "@/lib/database";
import BaseDatabaseRenderer, { ASTStatment } from "./base-database-renderer";
import { AST  } from "node-sql-parser";
import { format } from "sql-formatter";
import { TableType } from "@/lib/schemas/table-schema";
import { FieldType } from "@/lib/schemas/field-schema";
import { ForeignKeyActions, Modifiers, TimeDefaultValues } from "@/lib/field";
import { Cardinality, RelationshipType } from "@/lib/schemas/relationship-schema";
import { IndexType } from "@/lib/schemas/index-schema";
import { DataType } from "@/lib/schemas/data-type-schema";

 

export abstract class BaseSQLRenderer extends BaseDatabaseRenderer {

    protected async astToSQL(ast: ASTStatment[]): Promise<string> {
        // in the base SQL Render we use node-sql-parser . 
        // by simly passing the AST and formating the code . 
        // other renderers can override this method to handle the parsing based on the dielact
        await this.readyPromise ;  

        const sqlParts = ast.map((statement) => typeof statement === 'string'
            ? statement
            : `${this.parser.sqlify(statement as AST, { database: getDatabaseByDialect(this.dialect).name })};`);
        let sql: string = sqlParts.join('\n');
        return format(sql, { language: 'sql' });
    }

    protected createTableAst(table: TableType): ASTStatment[] | ASTStatment {
        // get the tale defintion from parent render that contain only the field defintion and primary keys contraints
        // this definition is commun amount (Mysql , MariaDB , Sqlite) , for postgres we need to override it and handle enums
        const { field_definitions, constraints, indices_ast, checks } = super.createTableAst(table) as any
        // wrape those defintion with create table AST 
        return [{
            keyword: "table",
            type: "create",
            table: [{
                db: table.namespace ?? null,
                table: table.name,
            }],
            create_definitions: [
                ...field_definitions,
                ...constraints,
                // The expression is written verbatim ("default" nodes print their value as-is)
                // so what the user typed is what lands in the DDL.
                ...checks.map((check: { name: string; expression: string }) => ({
                    constraint_type: "check",
                    keyword: "constraint",
                    constraint: check.name,
                    index_type: null,
                    definition: [{ type: "default", value: check.expression.trim() }],
                    resource: "constraint",
                })),
            ]
        }, ...indices_ast] as any
    }

  
    protected getFieldDefinition(field: FieldType, table: TableType, ignorePkContraint: boolean): AST {
        // we get the base field definition from the parent renderer 
        const definition: any = super.getFieldDefinition(field, table, ignorePkContraint)
        // Mysql , MariaDB ,Have some additional attributes such as charset collation , the enum values are inline unlike Postgres , Unsigned , and ZERO FILL  
        // also we need default value expression that it is compatible with node-sql-parser 
        let valuesExpr: any | null;
        // if the definition extracted values os this field is an enum . 
        // and for that we generate the values expression that's compatible with out parser
        if (definition.values && definition.values.length > 0) {
            const values = definition.values.map((value: string) => ({
                type: "single_quote_string",
                value
            }));

            valuesExpr = {
                parentheses: true,
                type: "expr_list",
                value: values
            }
        }

        const isGenerated = Boolean(field.generatedExpression && field.generatedExpression.trim());
        const default_val = (!isGenerated && !definition.modifiers.includes(Modifiers.NO_DEFAULT)) ? this.processDefaultValue(field) : undefined;
        const unique: string | null = !definition.modifiers.includes(Modifiers.NO_UNIQUE) ? (field.unique ? "unique" : null) : null;
        const expr = field.generatedExpression ? field.generatedExpression.trim() : "";
        const wrappedExpr = (expr.startsWith('(') && expr.endsWith(')')) ? expr : `(${expr})`;
        const storageType = (this.dialect === DatabaseDialect.POSTGRES)
            ? "stored"
            : (field.generationType === "stored" ? "stored" : "virtual");

        // return an AST statment for a field definition 
        return {
            column: {
                type: "column_ref",
                column: {
                    expr: {
                        type: "default", value: field.name,
                    }
                },
            },
            default_val,
            unique,
            auto_increment: (!isGenerated && definition.auto_increment) ? "auto_increment" : undefined,
            nullable: {
                type: field.nullable ? "null" : "not null",
                value: field.nullable ? "null" : "not null",
            },
            definition: {
                dataType: definition.dataType,
                length: definition.length,
                scale: definition.scale,
                expr: valuesExpr
            },
            primary_key: definition.primary_key ? "primary key" : null,
            ...(isGenerated ? {
                generated: {
                    type: "generated",
                    expr: {
                        type: "default",
                        value: wrappedExpr,
                    },
                    value: "generated always as",
                    storage_type: storageType,
                }
            } : {}),
            resource: "column"
        } as any
    }

    protected createRelationshipAst(relationship: RelationshipType): ASTStatment  {
        // get the foriegn key , primary key source table and target table from the parent renderer
        const { primaryKeys, foreignKeys, sourceTable, targetTable } = super.createRelationshipAst(relationship) as any;
        let on_action: any[] = [];
        // get the foriegn key actions for on delete and on cascade 
        if (relationship.onDelete) {
            const value: string | null = this.foreignKeyActionToAst(relationship.onDelete as ForeignKeyActions);

            if (value)
                on_action.push({
                    type: "on delete",
                    value: {
                        type: "origin",
                        value
                    }
                })
        }

        if (relationship.onUpdate) {
            const value: string | null = this.foreignKeyActionToAst(relationship.onUpdate as ForeignKeyActions);
            if (value)
                on_action.push({
                    type: "on update",
                    value: {
                        type: "origin",
                        value
                    }
                })
        }
        // return create foriegn key contraint for Mysql Dialect 
        return {
            type: "alter",
            keyword: "table",
            table: [
                {

                    db: targetTable.namespace ?? null,
                    table: targetTable.name
                }
            ],
            expr: [{
                action: "add",
                create_definitions: {
                    constraint: relationship.name,
                    definition: foreignKeys.map((field: FieldType) => ({
                        type: "column_ref",
                        table: null,
                        column: {
                            expr: {
                                type: "default",
                                value: field.name
                            }
                        },
                    })),
                    constraint_type: "FOREIGN KEY",
                    keyword: "constraint",
                    resource: "constraint",
                    reference_definition: {
                        definition: primaryKeys.map((field: FieldType) => ({
                            type: "column_ref",
                            table: null,
                            column: {
                                expr: {
                                    type: "default",
                                    value: field.name
                                }
                            },
                        })),
                        table: [
                            {
                                db: sourceTable.namespace ?? null,
                                table: sourceTable.name
                            }
                        ],
                        keyword: "references",
                        on_action
                    }
                },

                resource: "constraint",
                type: "alter"
            }]
        } as any
    }
  
 

    protected foreignKeyActionToAst(action: ForeignKeyActions): string | null {
        switch (action) {
            case ForeignKeyActions.CASCADE:
                return "cascade";

            case ForeignKeyActions.SET_NULL:
                return "set null";

            case ForeignKeyActions.RESTRICT:
                return "restrict";

            case ForeignKeyActions.SET_DEFAULT:
                return "set default";
        }
        return null;
    }

    protected getPrimaryKeyContraint(primaryKeys: FieldType[]): AST {
        // primary key contraint 
        return {
            constraint_type: "primary key",
            resource: "constraint",
            definition: primaryKeys.map((field: FieldType) => ({
                column: field.name,
                type: "column_ref"
            }))
        } as any
    }

    protected createIndexAst(table: TableType, index: IndexType): AST {
        // create index AST for Mysql Dielect 
        return {
            index: index.name,
            type: "create",
            table: { db: table.namespace ?? null, table: table.name },
            keyword: "index",
            on_kw: "on",
            index_type: index.unique ? "unique" : null,
            index_columns: index.fields.map((field: FieldType) => ({
                column: field.name,
                type: "column_ref"
            }))
        } as AST
    }
 
    protected processDefaultValue(field: FieldType): AST | null {
        const definition = super.processDefaultValue(field) as any;
        // if the field have a default value , then we generate an expression based on the type of the default value
        if (definition && definition.default_value !== null) {
            let default_val: any | null = null
            if (definition.default_value_type == "string")
                default_val = {
                    type: "default",
                    value: {
                        type: "single_quote_string",
                        value: field.defaultValue
                    }
                }
            else if (definition.default_value_type == "function" && field.defaultValue == TimeDefaultValues.NOW)
                default_val = {
                    type: "default",
                    value: {
                        type: "function",
                        name: {
                            name: [
                                {
                                    type: "origin",
                                    value: "CURRENT_TIMESTAMP"
                                }
                            ]
                        },
                        over: null
                    }
                }
            else if (definition.default_value_type == "function" && field.defaultValue == "random") {
                default_val = {
                    type: "default",
                    value: {
                        type: "function",
                        name: {
                            name: [
                                {
                                    type: "default",
                                    value: this.dialect == DatabaseDialect.POSTGRES ? "gen_random_uuid" : "UUID"
                                }
                            ]
                        },
                        args: {
                            type: "expr_list",
                            value: []
                        },
                        parentheses: this.dialect == DatabaseDialect.MARIADB
                    }
                }
            }
            else {
                default_val = {
                    type: "default",
                    value: {
                        type: definition.default_value_type,
                        value: definition.default_value
                    }
                }
            }
            return default_val;
        }
        return null;
    }


    protected startTransaction(): string {
        return "BEGIN TRANSACTION;" ;  
    }

    protected commit(): string {
        return "COMMIT;" 
    }



    protected abstract getUsingAst(table: TableType, field: FieldType, dataType: DataType): AST | null;
}
