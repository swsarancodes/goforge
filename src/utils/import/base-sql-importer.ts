
import { randomColor } from '@/lib/colors';
import { DatabaseDialect } from '@/lib/database';
import { DataTypes, ForeignKeyActions, Modifiers, TimeDefaultValues } from '@/lib/field';
import { DataType } from '@/lib/schemas/data-type-schema';
import { FieldInsertType } from '@/lib/schemas/field-schema';
import { IndexInsertType } from '@/lib/schemas/index-schema';
import { Cardinality, RelationshipInsertType } from '@/lib/schemas/relationship-schema';
import { qualifiedTableName, TableInsertType  } from '@/lib/schemas/table-schema';
import { extractViewDependencies, ViewInsertType } from '@/lib/schemas/view-schema';
import { SequenceInsertType } from '@/lib/schemas/sequence-schema';
import { init, parse, ReferentialAction } from '@guanmingchiu/sqlparser-ts';
import { v4 } from 'uuid';


export class BaseSqlImporter {


    protected data_types: DataType[] = [];
    protected dialect: DatabaseDialect | undefined;

    public constructor(data_types: DataType[]) {
        this.data_types = data_types;
        init();
    }

    public parseSql(sql: string) {

        let errors: Error[] = [];

        const tables: TableInsertType[] = [];
        const relationships: RelationshipInsertType[] = [];
        const indexes: IndexInsertType[] = [];
        const views: ViewInsertType[] = [];
        const sequences: SequenceInsertType[] = [];
        const fk_constraints: any[] = [];

        const cleaned = this.cleanSql(sql);

        const { createIndexStatements, alterTableStatements, createTableStatements, createViewStatements, createSequenceStatements } = this.extractStatments(cleaned);

        try {
            for (const statment of createTableStatements) {

                try {
                    const astStatment: any = parse(statment, this.dialect as any)?.pop();

                    if (astStatment?.CreateTable) {
                        const {
                            table,
                            errors: tableErrors,
                            fk_constraints: tableFkConstraints,
                            indexes: tableIndexes,
                        } = this.astToTable(astStatment);
                        if (table)
                            tables.push(table);
                        errors.push(...tableErrors);
                        indexes.push(...tableIndexes);

                        if (tableFkConstraints)
                            fk_constraints.push(...tableFkConstraints);

                    }
                } catch (error) {
                    errors.push(this.statementError(error, statment, cleaned));
                }

            }
            for (const statment of createViewStatements ?? []) {
                try {
                    const astStatment: any = parse(statment, this.dialect as any)?.pop();
                    if (astStatment?.CreateView) views.push(this.astToView(astStatment.CreateView, statment));
                } catch (error) {
                    errors.push(this.statementError(error, statment, cleaned));
                }
            }
            for (const statment of createSequenceStatements ?? []) {
                try {
                    sequences.push(this.sequenceFromStatement(statment));
                } catch (error) {
                    errors.push(this.statementError(error, statment, cleaned));
                }
            }
            for (const statment of alterTableStatements) {
                try {
                    const astStatment: any = parse(statment, this.dialect as any)?.pop();

                    if (astStatment?.AlterTable) {

                        for (const operation of astStatment.AlterTable.operations) {

                            if (operation.AddConstraint?.constraint?.ForeignKey) {

                                const targetTableName = this.qualifiedIdentifier(astStatment.AlterTable.name);
                                if (!targetTableName)
                                    continue;

                                fk_constraints.push({
                                    ...operation.AddConstraint.constraint.ForeignKey,
                                    target_table: targetTableName
                                })

                            }
                            else if (operation.AddConstraint?.constraint?.Unique) {

                                const table: TableInsertType | undefined = this.findTable(tables, this.qualifiedIdentifier(astStatment.AlterTable.name));

                                const columns: any[] | undefined = operation.AddConstraint?.constraint?.Unique?.columns;

                                if (!table || !columns) {
                                    continue;
                                }
                                if (columns.length > 0 && table.fields) {
                                    const uniqueIndex = this.uniqueConstraintToIndex(operation.AddConstraint.constraint.Unique, table);
                                    indexes.push(uniqueIndex);
                                    if (uniqueIndex.fieldIndices.length === 1) {
                                        const uniqueField = table.fields.find((field) => field.id === uniqueIndex.fieldIndices[0].fieldId);
                                        if (uniqueField) uniqueField.unique = true;
                                    }
                                }
                            } else if (operation.AddConstraint?.constraint.PrimaryKey) {

                                const table: TableInsertType | undefined = this.findTable(tables, this.qualifiedIdentifier(astStatment.AlterTable.name));

                                const columns: any[] | undefined = operation.AddConstraint?.constraint?.PrimaryKey?.columns;

                                if (!table || !columns) {
                                    continue;
                                }
                                if (columns && columns.length > 0 && table.fields) {
                                    for (const { column } of columns) {
                                        const index = table.fields.findIndex((field: FieldInsertType) => field.name == column?.expr?.Identifier?.value);
                                        if (index >= 0) {
                                            table.fields[index].isPrimary = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                } catch (error) {
                    errors.push(this.statementError(error, statment, cleaned))
                    continue;
                }

            }
            for (const statment of createIndexStatements) {
                try {
                    const astStatment: any = parse(statment, this.dialect as any)?.pop();

                    if (astStatment.CreateIndex) {
                        const { index, error: indexErrors } = this.astToIndex(astStatment, tables);


                        if (indexErrors)
                            errors.push(indexErrors);

                        if (index)
                            indexes.push(index)
                    }
                } catch (error) {
                    errors.push(this.statementError(error, statment, cleaned));
                }
            }
            for (const constraint of fk_constraints) {
                try {
                    relationships.push(this.astToRelationship(constraint, tables))
                } catch (error) {
                    errors.push(error as Error);
                }
            } 

            if (tables.length === 0 && views.length === 0 && sequences.length === 0) {
                const details = errors
                    .map((error) => error instanceof Error ? error.message : String(error))
                    .filter((message) => message.trim().length > 0);

                throw Error(
                    details.length > 0
                        ? `SQL parsing failed: ${details.join("; ")}`
                        : "No supported SQL schema statements found. Add a CREATE TABLE, CREATE VIEW, or CREATE SEQUENCE statement.",
                );
            }
            return {
                tables,
                relationships,
                indexes,
                views,
                sequences,
                errors
            }

        } catch (error) {
            throw error;
        }


    }

    protected astToTable(ast: any): ParsedTable {
        const errors: Error[] = []
        const tableParts = ast.CreateTable.name as any[] | undefined;
        const tableName: string | undefined = tableParts?.at(-1)?.Identifier?.value;
        const namespace = tableParts && tableParts.length > 1
            ? tableParts.slice(0, -1).map((part) => part?.Identifier?.value).filter(Boolean).join('.')
            : undefined;
        const columns: any[] = ast.CreateTable.columns;
        const fk_constraints: any[] = [];
        const indexes: IndexInsertType[] = [];


        if (!tableName || !columns)
            throw Error("Invalid table defintiion");

        const fields: FieldInsertType[] = []

        for (let index = 0; index < columns.length; index++) {
            try {

                const { field, fk_constraint } = this.astToField(columns[index], index);
                fields.push(field);

                if (fk_constraint) {
                    fk_constraints.push({
                        ...fk_constraint,
                        columns: [{
                            value: field.name
                        }],
                        target_table: this.qualifiedIdentifier(tableParts)
                    })
                }
            } catch (error) {
                errors.push(error as Error);
                continue
            }
        }

        if (ast.CreateTable.constraints && ast.CreateTable.constraints.length > 0) {
            for (const constraint of ast.CreateTable.constraints) {
                if (constraint.ForeignKey) {
                    fk_constraints.push({
                        ...constraint.ForeignKey,
                        target_table: this.qualifiedIdentifier(tableParts)
                    });
                }
                else if (constraint.PrimaryKey) {
                    for (const { column } of constraint.PrimaryKey.columns) {

                        const columnName: string | undefined = column.expr?.Identifier?.value;
                        if (!columnName)
                            continue;
                        const index = fields.findIndex((field: FieldInsertType) => field.name === columnName);
                        if (index >= 0) {
                            fields[index].isPrimary = true;
                        }
                    }
                } else if (constraint.Unique) {
                    try {
                        const uniqueIndex = this.uniqueConstraintToIndex(constraint.Unique, {
                            id: "pending",
                            name: tableName,
                            fields,
                        } as TableInsertType);
                        indexes.push(uniqueIndex);
                        if (uniqueIndex.fieldIndices.length === 1) {
                            const uniqueField = fields.find((field) => field.id === uniqueIndex.fieldIndices[0].fieldId);
                            if (uniqueField) uniqueField.unique = true;
                        }
                    } catch (error) {
                        errors.push(error as Error);
                    }
                }
            }
        }
        const tableId = v4();
        const table = {
                id: tableId,
                name: tableName,
                namespace,
                fields: fields,
                color: randomColor()
            } as TableInsertType;
        indexes.forEach((index) => {
            index.tableId = tableId;
        });
        return {
            table,
            errors,
            fk_constraints,
            indexes,
        }
    }

    protected astToField(ast: any, sequence: number): ParsedField {

        let isPrimary: boolean = false;
        let nullable: boolean = true;
        let unique: boolean = false;
        let autoIncrement: boolean = false;
        let maxLength: number | undefined;
        let precision: number | undefined;
        let scale: number | undefined;
        let values: any[] | string | undefined = undefined;
        let defaultValue: string | undefined;
        let typeName: string | undefined;
        let extraParam: number | undefined;
        let fk_constraint: any | undefined;
        let params: any[] | undefined;

      
        // if it's a basic type like (texts , booleans .. ect) we get the name directly
        // if it's a type that take params , the data type become an object
        if (typeof ast.data_type === "string") {
            typeName = ast.data_type.toLowerCase();
            

        } else if (typeof ast.data_type === "object" && !ast.data_type.Custom) {
            const attributeName = Object.keys(ast.data_type)[0];
            if (ast.data_type[attributeName]?.IntegerLength) {

                maxLength = ast.data_type[attributeName]?.IntegerLength?.length;
            }
            if (ast.data_type[attributeName]?.Precision) {
                precision = ast.data_type[attributeName]?.Precision;
            }

            if (ast.data_type[attributeName]?.PrecisionAndScale && ast.data_type[attributeName]?.PrecisionAndScale?.length == 2) {
                precision = ast.data_type[attributeName]?.PrecisionAndScale[0];
                scale = ast.data_type[attributeName]?.PrecisionAndScale[1];
            }

            if (typeof ast.data_type[attributeName] == "number") {
                extraParam = ast.data_type[attributeName];
            }

            if (Array.isArray(ast.data_type[attributeName])) {
                params = ast.data_type[attributeName];
            }
            typeName = attributeName.toLowerCase();

            // sqlparser-ts represents PostgreSQL TIMESTAMPTZ as
            // { Timestamp: [precision, "Tz"] }. Treating that as plain
            // TIMESTAMP silently changed the type on every SQL round trip.
            if (
                typeName === "timestamp" &&
                this.dialect === DatabaseDialect.POSTGRES &&
                Array.isArray(ast.data_type[attributeName]) &&
                ast.data_type[attributeName][1] === "Tz"
            ) {
                typeName = "timestamptz";
            }

            
            if (typeName == "timestamp" && this.dialect == DatabaseDialect.ORACLE && ast.data_type[attributeName].length >= 2 && ast.data_type[attributeName][1] == "WithTimeZone") { 
                typeName += "withtimezone" ; 
            } 
        }

        else if (ast.data_type.Custom && Array.isArray(ast.data_type.Custom)) {
            if (ast.data_type.Custom.length > 1 && ast.data_type.Custom[1]?.[0] && !isNaN(Number(ast.data_type.Custom[1]?.[0])))
                extraParam = Number(ast.data_type.Custom[1]?.[0]);

            typeName = ast.data_type.Custom[0]?.[0]?.Identifier?.value.toLowerCase();
            
        }
 
        const dataType: DataType | undefined = this.processDataType(typeName as string);

        if (!dataType) {
            throw Error("Data type not found");
        }
        // get data type modifiers
        const modifiers: string[] = dataType?.modifiers ? JSON.parse(dataType.modifiers) : [];
        // the parser pass an extra param in case if the type is cutsom , that extra param can be either a length or precision 
        // to know which one we have to test what kind of modifier the data type support 
        if (extraParam && modifiers.includes(Modifiers.LENGTH))
            maxLength = extraParam;

        if (extraParam && modifiers.includes(Modifiers.PRECISION))
            precision = extraParam;

        if (params && params.length > 0 && Array.isArray(params[0]) && modifiers.includes(Modifiers.VALUES)) {

            const paramValues = params[0].filter((value: any) => value.Name !== undefined).map((value: any) => value.Name);
            if (paramValues.every(v => typeof v === "string")) {
                values = JSON.stringify(paramValues);
            }
        }

        if (modifiers.includes(Modifiers.PRECISION) && params && params.length > 0 && !isNaN(params[0]) && !precision) {
            precision = params[0];
        }

        // get field defintion options
        const options: any | undefined = [] = ast.options;

        try {
            for (const option of options) {
                if (typeof option.option == "string") {

                    if (option.option == "Null")
                        nullable = true;

                    if (option.option == "NotNull")
                        nullable = false;

                    continue;
                }
                else if (typeof option.option === "object") {

                    if (option.option.PrimaryKey) {
                        isPrimary = true;
                        continue;
                    }
                    if (option.option.Unique) {
                        unique = true;
                        continue;
                    }
                    if (option.option.Default) {

                        defaultValue = this.processDefaultValue(option.option.Default, dataType);
                        continue;
                    }
                    if (option.option.DialectSpecific && option.option.DialectSpecific.length > 0) {
                        for (const { Word } of option.option.DialectSpecific) {
                            if (Word?.keyword == "AUTO_INCREMENT") {
                                autoIncrement = true;
                                break;
                            }
                        }
                    }
                    if (option.option.ForeignKey) {
                        fk_constraint = option.option.ForeignKey;
                    }
                }
            }
        } catch (error) {
            throw Error("Failed to extract column options")
        }

        if (isPrimary) {
            nullable = false;
        }

        return {
            field: {
                id: v4(),
                name: ast.name.value,
                typeId: dataType?.id,
                nullable,
                autoIncrement,
                unique,
                isPrimary,
                maxLength,
                precision,
                scale,
                defaultValue,
                sequence,
                values
            } as FieldInsertType,
            fk_constraint
        };

    }
    protected astToRelationship(ast: any, tables: TableInsertType[]): RelationshipInsertType {


        let targetTable: TableInsertType | undefined = this.findTable(tables, ast.target_table);
        let sourceTable: TableInsertType | undefined = this.findTable(tables, this.qualifiedIdentifier(ast.foreign_table));

        // referred_columns are the parent-table (source) columns, columns are the
        // FK-holding (target) columns; a composite FK lists more than one of each,
        // matched up pairwise in declaration order.
        const referredColumnNames: string[] = (ast.referred_columns ?? [])
            .map((column: any) => column?.value)
            .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
        const columnNames: string[] = (ast.columns ?? [])
            .map((column: any) => column?.value)
            .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);

        const sourceFieldsByName = new Map((sourceTable?.fields ?? []).map((field) => [field.name, field]));
        const targetFieldsByName = new Map((targetTable?.fields ?? []).map((field) => [field.name, field]));

        const sourceFields: (FieldInsertType | undefined)[] = referredColumnNames.map((name) => sourceFieldsByName.get(name));
        const targetFields: (FieldInsertType | undefined)[] = columnNames.map((name) => targetFieldsByName.get(name));

        const sourceField: FieldInsertType | undefined = sourceFields[0];
        const targetField: FieldInsertType | undefined = targetFields[0];

        if (
            !sourceTable || !sourceField || !targetField || !targetTable ||
            sourceFields.length !== targetFields.length ||
            sourceFields.some((field) => !field) || targetFields.some((field) => !field)
        ) {
            throw Error("Inavlid FK Constraint")

        }

        const onDelete: ForeignKeyActions | undefined = ast.on_delete ? this.astToForiegnKeyAction(ast.on_delete) : undefined;
        const onUpdate: ForeignKeyActions | undefined = ast.on_update ? this.astToForiegnKeyAction(ast.on_update) : undefined;
        const name: string | undefined = ast.name?.value;
        const relationshipId = v4();

        // Extra column pairs beyond the first are captured as relationshipFields;
        // sourceFieldId/targetFieldId above always carry that first pair so every
        // single-column consumer keeps working unchanged.
        const relationshipFields = sourceFields.slice(1).map((field, index) => ({
            id: v4(),
            relationshipId,
            sourceFieldId: (field as FieldInsertType).id,
            targetFieldId: (targetFields[index + 1] as FieldInsertType).id,
            sequence: index + 1,
        }));

        return {
            id: relationshipId,
            name,
            sourceFieldId: sourceField.id,
            targetFieldId: targetField.id,
            sourceTableId: sourceTable.id,
            targetTableId: targetTable.id,
            cardinality: targetField.unique ? Cardinality.one_to_one : Cardinality.one_to_many,
            onDelete,
            onUpdate,
            relationshipFields: relationshipFields.length > 0 ? relationshipFields : undefined,
        } as RelationshipInsertType
    }
    protected astToIndex(ast: any, tables: TableInsertType[]): ParsedIndex {

        const qualifiedName = this.qualifiedIdentifier(ast.CreateIndex.table_name);
        const tableName: string = ast.CreateIndex.table_name?.at(-1)?.Identifier?.value;
        const table: TableInsertType | undefined = this.findTable(tables, qualifiedName);

        if (!table)
            throw Error("index table not found");

        const columnNames: string[] = ast.CreateIndex.columns.map(({ column }: any) => column.expr?.Identifier?.value)
            .filter((column: string | undefined) => column != undefined);

        const fieldIds: string[] = columnNames.map((columnName) =>
            table.fields?.find((field: FieldInsertType) => field.name === columnName)?.id
        ).filter((id): id is string => Boolean(id));

        if (columnNames.length === 0 || fieldIds.length !== columnNames.length) {
            throw Error(`Index ${ast.CreateIndex.name?.[0]?.Identifier?.value ?? ""} references an unknown column`);
        }

        let indexName: string = ast.CreateIndex.name?.[0]?.Identifier?.value;
        if (!indexName) {
            indexName = `${tableName}_${columnNames.join("_")}_index`;
        }

        return {
            index: {
                id: v4(),
                name: indexName,
                tableId: table.id,
                unique: ast.CreateIndex.unique,
                fieldIndices: fieldIds.map((id: string) => ({
                    id: v4(),
                    fieldId: id
                }))
            } as IndexInsertType,
            error: undefined
        }
    }

    protected astToView(ast: any, statement: string): ViewInsertType {
        const nameParts = ast.name as any[] | undefined;
        const name = nameParts?.at(-1)?.Identifier?.value;
        if (!name) throw new Error('Invalid view definition');

        const asMatch = statement.match(/\s+AS\s+/i);
        if (!asMatch || asMatch.index === undefined) throw new Error(`View ${name} is missing AS`);
        const definition = statement.slice(asMatch.index + asMatch[0].length).replace(/;\s*$/, '').trim();
        if (!definition) throw new Error(`View ${name} is missing a query definition`);

        return {
            id: v4(),
            name,
            namespace: nameParts && nameParts.length > 1
                ? nameParts.slice(0, -1).map((part) => part?.Identifier?.value).filter(Boolean).join('.')
                : undefined,
            materialized: Boolean(ast.materialized),
            definition,
            dependencies: JSON.stringify(extractViewDependencies(definition)),
        } as ViewInsertType;
    }

    protected sequenceFromStatement(statement: string): SequenceInsertType {
        const identifier = '(?:"[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
        const match = statement.match(new RegExp(
            `^CREATE\\s+(?:OR\\s+REPLACE\\s+)?SEQUENCE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier}(?:\\s*\\.\\s*${identifier}){0,2})([\\s\\S]*)$`,
            'i',
        ));
        if (!match) throw new Error('Invalid sequence definition');

        const parts = match[1].split(/\s*\.\s*/).map((part) => part.replace(/^["`\[]|["`\]]$/g, ''));
        const name = parts.at(-1);
        if (!name) throw new Error('Invalid sequence name');

        return {
            id: v4(),
            name,
            namespace: parts.length > 1 ? parts.slice(0, -1).join('.') : undefined,
            definition: match[2].replace(/;\s*$/, '').trim(),
        } as SequenceInsertType;
    }

    protected uniqueConstraintToIndex(constraint: any, table: TableInsertType): IndexInsertType {
        const columnNames: string[] = (constraint.columns ?? [])
            .map(({ column }: any) => column?.expr?.Identifier?.value)
            .filter((name: unknown): name is string => typeof name === "string" && name.length > 0);
        const fieldsByName = new Map((table.fields ?? []).map((field) => [field.name, field]));
        const constraintFields = columnNames.map((name) => fieldsByName.get(name));

        if (columnNames.length === 0 || constraintFields.some((field) => !field)) {
            throw new Error(`Unique constraint on "${table.name}" references an unknown column`);
        }

        const indexId = v4();
        return {
            id: indexId,
            name: constraint.name?.value ?? `${table.name}_${columnNames.join("_")}_key`,
            tableId: table.id,
            unique: true,
            fieldIndices: constraintFields.map((field) => ({
                id: v4(),
                indexId,
                fieldId: field?.id,
            })),
        } as IndexInsertType;
    }

    protected astToForiegnKeyAction(ast: ReferentialAction): ForeignKeyActions {
        switch (ast) {
            case "Cascade":
                return ForeignKeyActions.CASCADE;
            case "SetNull":
                return ForeignKeyActions.SET_NULL;
            case 'Restrict':
                return ForeignKeyActions.RESTRICT;
            case "SetDefault":
                return ForeignKeyActions.SET_DEFAULT;
        }
        return ForeignKeyActions.NO_ACTION;
    }

    protected qualifiedIdentifier(parts: any[] | undefined): string {
        return (parts ?? [])
            .map((part) => part?.Identifier?.value)
            .filter((value): value is string => typeof value === 'string' && value.length > 0)
            .join('.');
    }

    protected findTable(tables: TableInsertType[], identifier: string | undefined): TableInsertType | undefined {
        if (!identifier) return undefined;
        const exact = tables.find((table) => qualifiedTableName(table) === identifier);
        if (exact || identifier.includes('.')) return exact;
        return tables.find((table) => table.name === identifier);
    }

    protected processDataType(typeName: string): DataType | undefined   {
        
        
        // get data type from the supported ones
        return this.data_types.find((dataType: DataType) => {
            let synonyms: string[] = dataType.synonyms ? JSON.parse(dataType.synonyms) : [];
            synonyms = synonyms.map((synonym: string) => synonym.replace(/ /g, ''));
            return (dataType.name as string).replace(/ /g, '') == typeName || synonyms.includes(typeName as string)
        });

    }

    protected processDefaultValue(ast: any, dataType: DataType): string | undefined {
       
        if (ast.Value && ast.Value.value) {
        
            const value: any = ast.Value.value;
            if (value.Number && Array.isArray(value.Number) && value.Number.length > 0 && !isNaN(Number(value.Number[0]))) {
                return value.Number[0];
            }
        
            else if (value.SingleQuotedString || value.DoubleQuotedString) {
                const valuesArray = Object.values(value);
                if (valuesArray.length > 0)
                    return valuesArray[0] as string;
            }
        
            else if (value.Boolean) {
                return "true";
            }
        
            else if (value.NationalStringLiteral) {
                return value.NationalStringLiteral
            }
        
        } else if (ast.Function) {
            if (dataType.type == DataTypes.TIME) {
                if (ast.Function.name?.[0]?.Identifier?.value && this.isCurrentTimesTampFunction(ast.Function.name?.[0]?.Identifier?.value))
                    return TimeDefaultValues.NOW;

            }
        } else if (ast.TypedString) {

            const value = ast.TypedString.value?.value;

            if (value.SingleQuotedString || value.DoubleQuotedString) {
                const valuesArray = Object.values(value);
                if (valuesArray.length > 0)
                    return valuesArray[0] as string;
            }
        }
        
        return undefined;
    }

    protected isCurrentTimesTampFunction(value: string): boolean {
        const upper: string = value.toUpperCase();

        return upper == "CURRENT_TIMESTAMP" || upper == "NOW";
    }


    protected cleanSql(sql: string): string {
        // Remove comments without changing line breaks. Keeping line breaks lets
        // parser errors report a useful line/column in the original input.
        return this.stripSqlComments(sql)
            .replace(/\r\n?/g, '\n')
            .trim();
    }

    protected stripSqlComments(sql: string): string {
        let output = '';
        let state: 'normal' | 'single' | 'double' | 'backtick' | 'bracket' | 'dollar' | 'line-comment' | 'block-comment' = 'normal';
        let dollarTag = '';

        for (let index = 0; index < sql.length; index++) {
            const character = sql[index];
            const next = sql[index + 1];

            if (state === 'dollar') {
                if (sql.startsWith(dollarTag, index)) {
                    output += dollarTag;
                    index += dollarTag.length - 1;
                    dollarTag = '';
                    state = 'normal';
                } else {
                    output += character;
                }
                continue;
            }

            if (state === 'line-comment') {
                if (character === '\n') {
                    output += character;
                    state = 'normal';
                } else {
                    output += ' ';
                }
                continue;
            }

            if (state === 'block-comment') {
                if (character === '*' && next === '/') {
                    output += '  ';
                    index++;
                    state = 'normal';
                } else {
                    output += character === '\n' ? '\n' : ' ';
                }
                continue;
            }

            if (state === 'normal') {
                if (character === '-' && next === '-') {
                    output += '  ';
                    index++;
                    state = 'line-comment';
                } else if (character === '/' && next === '*') {
                    output += '  ';
                    index++;
                    state = 'block-comment';
                } else {
                    output += character;
                    if (character === "'") state = 'single';
                    else if (character === '"') state = 'double';
                    else if (character === '`') state = 'backtick';
                    else if (character === '[') state = 'bracket';
                    else if (character === '$') {
                        const match = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
                        if (match) {
                            dollarTag = match[0];
                            output = output.slice(0, -1) + dollarTag;
                            index += dollarTag.length - 1;
                            state = 'dollar';
                        }
                    }
                }
                continue;
            }

            output += character;
            if (state === 'single' && character === "'") {
                if (next === "'") {
                    output += next;
                    index++;
                } else {
                    state = 'normal';
                }
            } else if (state === 'double' && character === '"') {
                if (next === '"') {
                    output += next;
                    index++;
                } else {
                    state = 'normal';
                }
            } else if (state === 'backtick' && character === '`') {
                if (next === '`') {
                    output += next;
                    index++;
                } else {
                    state = 'normal';
                }
            } else if (state === 'bracket' && character === ']') {
                if (next === ']') {
                    output += next;
                    index++;
                } else {
                    state = 'normal';
                }
            }
        }

        return output;
    }

    protected splitStatements(sql: string): string[] {
        // SQL Server exports commonly use GO as a batch separator. Treat only
        // standalone GO lines as separators; GO inside quoted text is untouched.
        const source = sql.replace(/^[ \t]*GO[ \t]*$/gim, ';');
        const statements: string[] = [];
        let statementStart = 0;
        let quote: 'single' | 'double' | 'backtick' | 'bracket' | 'dollar' | undefined;
        let dollarTag = '';

        const pushStatement = (end: number) => {
            const statement = source.slice(statementStart, end).trim();
            if (statement) statements.push(statement);
        };

        for (let index = 0; index < source.length; index++) {
            const character = source[index];
            const next = source[index + 1];

            if (quote === 'dollar') {
                if (source.startsWith(dollarTag, index)) {
                    index += dollarTag.length - 1;
                    quote = undefined;
                    dollarTag = '';
                }
                continue;
            }

            if (quote === 'single') {
                if (character === "'") {
                    if (next === "'") index++;
                    else quote = undefined;
                }
                continue;
            }
            if (quote === 'double') {
                if (character === '"') {
                    if (next === '"') index++;
                    else quote = undefined;
                }
                continue;
            }
            if (quote === 'backtick') {
                if (character === '`') {
                    if (next === '`') index++;
                    else quote = undefined;
                }
                continue;
            }
            if (quote === 'bracket') {
                if (character === ']') {
                    if (next === ']') index++;
                    else quote = undefined;
                }
                continue;
            }

            if (character === "'") quote = 'single';
            else if (character === '"') quote = 'double';
            else if (character === '`') quote = 'backtick';
            else if (character === '[') quote = 'bracket';
            else if (character === '$') {
                const match = source.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
                if (match) {
                    quote = 'dollar';
                    dollarTag = match[0];
                    index += dollarTag.length - 1;
                }
            } else if (character === ';') {
                pushStatement(index);
                statementStart = index + 1;
            }
        }

        pushStatement(source.length);
        return statements;
    }

    protected statementError(error: unknown, statement: string, source: string): Error {
        const message = error instanceof Error
            ? error.message
            : (typeof error === 'object' && error !== null && 'message' in error)
                ? String((error as { message: unknown }).message)
                : String(error);
        const index = source.indexOf(statement);
        if (index < 0) return new Error(message);

        const beforeStatement = source.slice(0, index);
        const line = beforeStatement.split('\n').length;
        const lineStart = beforeStatement.lastIndexOf('\n') + 1;
        const column = index - lineStart + 1;
        return new Error(`Line ${line}, column ${column}: ${message}`);
    }

    protected extractStatments(sql: string): ExtractedStatments {

        const createTableStatements: string[] = [];
        const alterTableStatements: string[] = [];
        const createIndexStatements: string[] = [];
        const createViewStatements: string[] = [];
        const createSequenceStatements: string[] = [];

        const statements = this.splitStatements(sql);


        for (const stmt of statements) {
            const upper = stmt.toUpperCase();

            if (/^CREATE\s+(?:(?:GLOBAL\s+|LOCAL\s+)?TEMPORARY\s+|UNLOGGED\s+)?TABLE\b/i.test(stmt)) {
                createTableStatements.push(stmt);
            } else if (/^CREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i.test(stmt)) {
                createViewStatements.push(stmt);
            } else if (/^CREATE\s+(?:OR\s+REPLACE\s+)?SEQUENCE\b/i.test(stmt)) {
                createSequenceStatements.push(stmt);
            } else if (upper.startsWith('ALTER TABLE')) {
                alterTableStatements.push(stmt);
            } else if (upper.startsWith('CREATE INDEX') || upper.startsWith('CREATE UNIQUE INDEX')) {
                createIndexStatements.push(stmt);
            }
        }
        return {
            createTableStatements,
            alterTableStatements,
            createIndexStatements,
            createViewStatements,
            createSequenceStatements,
        } as ExtractedStatments;
    }

}

export type ParsedDatabaase = {
    tables: TableInsertType[],
    relationships: RelationshipInsertType[],
    indexes: IndexInsertType[],
    views: ViewInsertType[],
    sequences: SequenceInsertType[],
    errors: Error[]
}

export type ParsedTable = {
    table: TableInsertType;
    errors: Error[];
    fk_constraints: any[] | undefined,
    indexes: IndexInsertType[],
}

export type ParsedIndex = {
    index: IndexInsertType;
    error?: Error;

}

export type ParsedField = {
    field: FieldInsertType,
    fk_constraint: any | undefined
}

export type ExtractedStatments = {
    createTableStatements: string[],
    alterTableStatements: string[],
    createIndexStatements: string[],
    createViewStatements: string[],
    createSequenceStatements: string[],
    createPostgresTypesStatements?: string[],
    alterSequenceStatments?: string[]
}





/*


START TRANSACTION;

CREATE TABLE `users` (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL
);

CREATE UNIQUE INDEX `users_usernae_index` ON `users` (`username`);

COMMIT;


CREATE TABLE `users` (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TEXT NULL DEFAULT 'Hello world' UNIQUE
);

CREATE INDEX `idx_users_created_at_index` ON `users` (`created_at`);

CREATE INDEX `idx_users_last_login_at` ON `users` (`last_login_at`);

CREATE TABLE `categories` (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  description TEXT NULL
);

CREATE TABLE `tags` (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE
);

CREATE TABLE `projects` (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  category_id INTEGER NULL,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER NULL,
  due_date DATETIME NULL,
  status ENUM (
    'planning',
    'in_progress',
    'completed',
    'on_hold',
    'draft'
  ) NOT NULL DEFAULT 'draft',
  FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`),
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
);

CREATE TABLE `tasks` (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  status ENUM ('todo', 'in_progress', 'done') NOT NULL DEFAULT 'todo',
  priority ENUM ('low', 'medium', 'high') NULL DEFAULT 'medium',
  due_date DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  project_id INTEGER NULL,
  assigned_to_user_id INTEGER NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`),
  FOREIGN KEY (`assigned_to_user_id`) REFERENCES `users` (`id`)
);

CREATE TABLE `comments` (
  id INTEGER NOT NULL AUTO_INCREMENT PRIMARY KEY,
  task_id INTEGER NOT NULL,
  comment TEXT NOT NULL,
  created_at DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
  user_id INTEGER NOT NULL,
  updated_at DATETIME NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`)
);

CREATE INDEX `idx_comments_created_at` ON `comments` (`created_at`);

CREATE INDEX `idx_comments_user_id` ON `comments` (`user_id`);

CREATE INDEX `idx_comments_task_id` ON `comments` (`task_id`);

CREATE TABLE `task_tags` (
  task_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  FOREIGN KEY (`tag_id`) REFERENCES `tags` (`id`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks` (`id`)
)
  
CREATE TABLE all_mysql_types (
  -- Numeric types
  col_tinyint        TINYINT(3),
  col_smallint       SMALLINT(5),
  col_mediumint      MEDIUMINT(7),
  col_int            INT(11),
  col_bigint         BIGINT(20),

  col_decimal        DECIMAL(10, 2),
  col_numeric        NUMERIC(8, 3),

  col_float          FLOAT(7, 4),
  col_double         DOUBLE(15, 8),
  col_real           REAL,
 
  col_boolean        BOOLEAN,

  -- Date & time types
  col_date           DATE,
  col_datetime       DATETIME(6),
  col_timestamp      TIMESTAMP(6),
  col_time           TIME(6),
  col_year           YEAR,

  -- String types
  col_char           CHAR(10),
  col_varchar        VARCHAR(255),

  col_binary         BINARY(16),
  col_varbinary      VARBINARY(255),

  col_tinytext       TINYTEXT,
  col_text           TEXT,
  col_mediumtext     MEDIUMTEXT,
  col_longtext       LONGTEXT,

  col_tinyblob       TINYBLOB,
  col_blob           BLOB,
  col_mediumblob     MEDIUMBLOB,
  col_longblob       LONGBLOB,

  col_enum           ENUM('A', 'B', 'C'),
  col_set            SET('X', 'Y', 'Z'),

  -- JSON
  col_json           JSON,

  -- Spatial types
  col_geometry       GEOMETRY,
  col_point          POINT,
  col_linestring     LINESTRING,
  col_polygon        POLYGON 
);




*/
