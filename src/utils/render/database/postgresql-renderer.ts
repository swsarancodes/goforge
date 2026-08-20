import { DataType } from "@/lib/schemas/data-type-schema";
import { DatabaseDialect, getDatabaseByDialect } from "@/lib/database";
import { FieldType } from "@/lib/schemas/field-schema";
import { TableType } from "@/lib/schemas/table-schema";
import { BaseSQLRenderer } from "./base-sql-renderer";
import { AST  } from "node-sql-parser";
import { getPostgresEnumName } from "../render-uttils";
import { Cardinality, RelationshipType } from "@/lib/schemas/relationship-schema";
import { IndexType } from "@/lib/schemas/index-schema";
import { Statement, toSql } from "pgsql-ast-parser";
import { ASTStatment } from "./base-database-renderer";
import { format } from "sql-formatter";
import { DBDiffOperation } from "@/utils/database";
import { DataTypes } from "@/lib/field";

// Statement `.type` values produced by pgsql-ast-parser (as opposed to node-sql-parser,
// whose AST objects use single-word types like "alter"/"create"/"drop") - these need
// toSql.statement() instead of this.parser.sqlify(). "alter table" here is only ever a
// RENAME COLUMN statement - node-sql-parser's postgres grammar can't parse or emit that,
// so it's the one case built via pgsql-ast-parser instead.
const PG_STATEMENT_TYPES = new Set(["alter index", "alter enum", "alter table"]);

export default class PostgresqlRenderer extends BaseSQLRenderer {

    public constructor(data_types: DataType[]) {
        super(DatabaseDialect.POSTGRES, data_types)
    }

    protected async astToSQL(ast: ASTStatment[]): Promise<string> {
        // postgres renderer is different , we use a different parser pgsql-ast-parser for index , enum renaming . 
        // those kind of operations return Statment not AST . 
        // so the we pass AST to the default parser and Statment to Postgres parser  

        await this.readyPromise ; 
        let sql: string[] = [];
        
        for (const statment of ast) {
            if (PG_STATEMENT_TYPES.has((statment as Statement)?.type)) {
                // statements built via pgsql-ast-parser (index/enum renaming, column renaming -
                // node-sql-parser's postgres grammar doesn't support RENAME COLUMN at all)
                sql.push(toSql.statement(statment as Statement) + ";");
            }
            else {
                const statment_sql = this.parser.sqlify(statment as AST, {
                    database: getDatabaseByDialect(this.dialect).name
                });
                sql.push(statment_sql + ";");
            }
        }

        if (sql.length > 0) {
            sql = [this.startTransaction( ) , ...sql , this.commit()]
        }
        return format(sql.join(""), { language: 'postgresql' });
    }

 
    protected createTableAst(table: TableType): AST[] | AST {
        // the only difference in create table statment in postgres is we need to get declare all enums before creating the table 
        const definition: AST[] = super.createTableAst(table) as any
        // so we need an enum ast 
        const enumsAst: AST[] = [];
        // get fields to type enum 
        let postgresEnums: FieldType[] = table.fields.filter((field: FieldType) => field.type?.name == "enum");
        if (postgresEnums.length > 0) {
            // loop over them and intiat them one by one 
            for (const postgresEnum of postgresEnums) {
                (postgresEnum as any).table = table;
                enumsAst.push(this.createEnumAst(postgresEnum));
            }
        }
        definition.splice(0, 0, ...enumsAst);
        return definition;
    }
 
 
    protected getFieldDefinition(field: FieldType, table: TableType, ignorePkContraint: boolean): AST {
        // we get the base field definition from the parent renderer 
        const definition: any = super.getFieldDefinition(field, table, ignorePkContraint);

        // since postrges uses the serial data types , then there is not need for auto incrmenet attribute 
        definition.auto_increment = undefined;
        // postgres handle enums diffrently , we need to create the enum first then reference to it in the column line 
        if (definition.definition.dataType == "ENUM") {
            definition.definition.dataType = getPostgresEnumName(table, field);
            definition.definition.expr = undefined;
        }
        return definition;
    }
 


    private createEnumAst(field: FieldType): AST {
        // get the enum values , and cast it into an array 
        const jsonValues = field.values ? JSON.parse(field.values) : [];
        // return the ast of creating a table
        return {
            as: "as",
            type: "create",
            resource: "enum",
            name: {
                schema: null,
                name: `${(field as any).table.name}_${field.name.toLowerCase()}_enum`
            },
            keyword: "type",
            create_definitions: {
                parentheses: true,
                type: "expr_list",
                value: jsonValues.map((value: string) => ({
                    type: "single_quote_string",
                    value
                }))
            }
        } as any
    }

    protected getUsingAst(table: TableType, field: FieldType, newDataType: DataType): AST | null {

        const oldType: DataTypes = field.type.type as DataTypes;
        const newType: DataTypes = newDataType.type as DataTypes;

        if (oldType === newType && oldType != DataTypes.ENUM) return null;

        if (
            (oldType === DataTypes.INTEGER && newType === DataTypes.NUMERIC) ||
            (oldType === DataTypes.NUMERIC && newType === DataTypes.INTEGER)
        ) return null;


        let dataType = newDataType.name?.toUpperCase();

        if (newDataType.name == "enum")
            dataType = "TEXT::" + getPostgresEnumName(table, field);
        else if (newDataType.name != "text")
            dataType = "TEXT::" + newDataType.name?.toUpperCase();

        return {
            as: null,
            symbol: "::",
            target: [
                {
                    dataType
                }
            ],
            type: "cast",
            keyword: "cast",
            expr: {
                type: "column_ref",
                table: null,
                column: {
                    expr: {
                        type: "default",
                        value: field.name
                    }
                },
                collate: null
            }
        } as any;
    }

    protected operationToAst(operation: DBDiffOperation): ASTStatment | ASTStatment[] | null {
        switch (operation.type) {
            case "CREATE_FIELD": {
                if (!operation.table) return null;
                const definition = this.getFieldDefinition(operation.field, operation.table, false) as any;
                return this.alterTableEnvelope(operation.table, {
                    ...definition,
                    action: "add",
                    keyword: "COLUMN",
                    type: "alter",
                });
            }

            case "DELETE_FIELD": {
                if (!operation.table || !operation.field) return null;
                return this.alterTableEnvelope(operation.table, {
                    action: "drop",
                    column: this.columnRef(operation.field.name),
                    if_exists: null,
                    keyword: "COLUMN",
                    resource: "column",
                    type: "alter",
                });
            }

            case "UPDATE_FIELD": {
                if (!operation.table || !operation.field) return null;
                return this.updateFieldStatements(operation.table, operation.field, operation.changes);
            }

            case "CREATE_INDEX": {
                if (!operation.table || !operation.index.fields || operation.index.fields.length === 0) return null;
                return this.createIndexAst(operation.table, operation.index) as any;
            }

            case "DELETE_INDEX": {
                if (!operation.index) return null;
                return {
                    type: "drop",
                    keyword: "index",
                    prefix: "",
                    name: {
                        type: "column_ref",
                        table: null,
                        column: { expr: { type: "default", value: operation.index.name } },
                        collate: null,
                    },
                    options: null,
                } as any;
            }

            case "DELETE_TABLE": {
                if (!operation.table) return null;
                return {
                    type: "drop",
                    keyword: "table",
                    prefix: null,
                    name: [{ db: null, table: operation.table.name, as: null }],
                } as any;
            }

            case "UPDATE_TABLE": {
                if (!operation.table || !operation.changes.name) return null;
                return this.alterTableEnvelope(operation.table, {
                    action: "rename",
                    type: "alter",
                    resource: "table",
                    keyword: "to",
                    table: operation.changes.name,
                });
            }

            default:
                return super.operationToAst(operation);
        }
    }

    private columnRef(name: string, suffix?: string): any {
        return {
            type: "column_ref",
            table: null,
            column: { expr: { type: "default", value: name } },
            collate: null,
            ...(suffix ? { suffix } : {}),
        };
    }

    private alterTableEnvelope(table: TableType, expr: any): any {
        return {
            type: "alter",
            keyword: "table",
            table: [{ db: null, table: table.name }],
            expr: [expr],
        };
    }

    /**
     * UPDATE_FIELD can touch several independent things at once (type, nullability,
     * default, name) - each becomes its own ALTER TABLE statement, since Postgres
     * has no single clause covering all of them together.
     */
    private updateFieldStatements(table: TableType, field: FieldType, changes: Partial<FieldType>): ASTStatment[] {
        const statements: ASTStatment[] = [];

        const isTypeChange = Boolean(
            changes.typeId || changes.maxLength || changes.scale || changes.precision || changes.autoIncrement !== undefined || changes.values
        );

        if (isTypeChange) {
            const updated = this.updateFieldAst(table, field, changes as FieldType) as any;
            if (updated?.dataType) {
                const newType: DataType = changes.typeId ? (changes as any).type : field.type;
                const usingAst = newType ? this.getUsingAst(table, field, newType) : null;

                statements.push(
                    this.alterTableEnvelope(table, {
                        action: "alter",
                        column: this.columnRef(field.name, "type"),
                        keyword: "COLUMN",
                        resource: "column",
                        definition: {
                            dataType: updated.dataType,
                            length: updated.length ?? undefined,
                            scale: updated.scale ?? undefined,
                            parentheses: Boolean(updated.length),
                        },
                        collate: null,
                        using: usingAst,
                        type: "alter",
                    })
                );
            }
        }

        if (changes.nullable !== undefined) {
            statements.push(
                this.alterTableEnvelope(table, {
                    action: "alter",
                    column: this.columnRef(field.name),
                    keyword: "COLUMN",
                    resource: "column",
                    nullable: { type: "not null", value: "not null", action: changes.nullable ? "drop" : "set" },
                    type: "alter",
                })
            );
        }

        if (changes.defaultValue !== undefined) {
            const default_val = changes.defaultValue
                ? (this.processDefaultValue({ ...field, defaultValue: changes.defaultValue }) as any)?.value
                    ? { type: "set default", value: (this.processDefaultValue({ ...field, defaultValue: changes.defaultValue }) as any).value }
                    : null
                : { type: "drop default" };

            if (default_val) {
                statements.push(
                    this.alterTableEnvelope(table, {
                        action: "alter",
                        column: this.columnRef(field.name),
                        keyword: "COLUMN",
                        resource: "column",
                        default_val,
                        type: "alter",
                    })
                );
            }
        }

        if (changes.name) {
            statements.push({
                type: "alter table",
                table: { name: table.name },
                changes: [
                    {
                        type: "rename column",
                        column: { name: field.name },
                        to: { name: changes.name },
                    },
                ],
            } as any as Statement);
        }

        return statements;
    }

    protected startTransaction(): string {
        return "BEGIN;" ;
    } 
}
