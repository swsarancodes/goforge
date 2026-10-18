import { cloneDeep } from "lodash";
import { DatabaseType } from "@/lib/schemas/database-schema";
import { TableType } from "@/lib/schemas/table-schema";
import { FieldType } from "@/lib/schemas/field-schema";
import { IndexType } from "@/lib/schemas/index-schema";
import { Cardinality, RelationshipType } from "@/lib/schemas/relationship-schema";
import { LintIssue, LinterOptions } from "./types";

export const SQL_RESERVED_WORDS = new Set([
    "user", "order", "group", "table", "select", "from", "where", "index", "key",
    "primary", "foreign", "check", "constraint", "default", "limit", "offset",
    "case", "when", "then", "else", "end", "database", "schema", "view",
    "sequence", "trigger", "procedure", "function", "values", "into", "insert",
    "update", "delete", "drop", "alter", "create", "add", "column", "set",
    "grant", "revoke", "all", "any", "some", "exists", "in", "between",
    "like", "is", "null", "not", "and", "or", "true", "false", "union",
    "intersect", "except", "distinct", "desc", "asc", "as", "by", "having"
]);

export function toSnakeCase(str: string): string {
    return str
        .replace(/([A-Z]+)/g, "_$1")
        .replace(/[-\s]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toLowerCase();
}

export function toCamelCase(str: string): string {
    return str
        .toLowerCase()
        .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ""));
}

export function matchesConvention(str: string, convention: "snake_case" | "camelCase" | "kebab-case" | "PascalCase" | "any"): boolean {
    if (convention === "any") return true;
    switch (convention) {
        case "snake_case":
            return /^[a-z][a-z0-9_]*$/.test(str);
        case "camelCase":
            return /^[a-z][a-zA-Z0-9]*$/.test(str);
        case "kebab-case":
            return /^[a-z][a-z0-9-]*$/.test(str);
        case "PascalCase":
            return /^[A-Z][a-zA-Z0-9]*$/.test(str);
        default:
            return true;
    }
}

/** Check 1: Tables without primary key */
export function checkMissingPrimaryKey(database: DatabaseType, options?: LinterOptions): LintIssue[] {
    const issues: LintIssue[] = [];
    for (const table of database.tables ?? []) {
        const hasPk = table.fields.some(f => f.isPrimary);
        if (!hasPk) {
            issues.push({
                id: `missing-pk-${table.id}`,
                ruleId: "require-primary-key",
                ruleName: "Require Primary Key",
                category: "integrity",
                severity: options?.severityOverrides?.["require-primary-key"] ?? "error",
                targetType: "table",
                targetId: table.id,
                tableName: table.name,
                message: `Table "${table.name}" does not define a primary key.`,
                suggestion: "Add a primary key column (such as an auto-incrementing 'id' or UUID) to ensure unique row identification.",
                fixable: true,
                fixDescription: `Add surrogate 'id' primary key column to "${table.name}"`,
                fix: (db: DatabaseType) => {
                    const cloned = cloneDeep(db);
                    const target = cloned.tables.find(t => t.id === table.id);
                    if (target) {
                        const idFieldId = `field_${table.name}_id_${Date.now()}`;
                        // Find integer or serial type
                        const intType = target.fields[0]?.type;
                        const newField: FieldType = {
                            id: idFieldId,
                            tableId: target.id,
                            name: "id",
                            isPrimary: true,
                            unique: true,
                            nullable: false,
                            autoIncrement: true,
                            sequence: 0,
                            typeId: target.fields[0]?.typeId ?? "type_integer",
                            type: intType ?? ({} as any),
                            defaultValue: null,
                            maxLength: null,
                            precision: null,
                            scale: null,
                            charset: null,
                            collate: null,
                            values: null,
                            unsigned: false,
                            isForeign: false,
                            zeroFill: false,
                            note: "Surrogate primary key",
                        };
                        target.fields.unshift(newField);
                    }
                    return cloned;
                }
            });
        }
    }
    return issues;
}

/** Check 2: Unindexed foreign key columns */
export function checkUnindexedForeignKeys(database: DatabaseType, options?: LinterOptions): LintIssue[] {
    const issues: LintIssue[] = [];
    for (const rel of database.relationships ?? []) {
        if (rel.cardinality === Cardinality.many_to_many) continue;

        // Foreign key column lives on targetTable (or sourceTable for reversed many_to_one)
        const fkTableId = rel.cardinality === Cardinality.many_to_one ? rel.sourceTableId : rel.targetTableId;
        const fkFieldId = rel.cardinality === Cardinality.many_to_one ? rel.sourceFieldId : rel.targetFieldId;
        const fkTable = database.tables.find(t => t.id === fkTableId);
        if (!fkTable) continue;

        const fkField = fkTable.fields.find(f => f.id === fkFieldId);
        if (!fkField || fkField.isPrimary) continue; // Primary keys already have implicit unique/index

        // Check if there is an index whose first column is fkFieldId
        const hasIndex = (fkTable.indices ?? []).some(idx => {
            const firstCol = idx.fieldIndices?.[0] || idx.fields?.[0];
            return firstCol && ((firstCol as any).fieldId === fkFieldId || (firstCol as any).id === fkFieldId);
        });

        if (!hasIndex) {
            issues.push({
                id: `unindexed-fk-${rel.id}`,
                ruleId: "unindexed-foreign-key",
                ruleName: "Index Foreign Key",
                category: "performance",
                severity: options?.severityOverrides?.["unindexed-foreign-key"] ?? "warning",
                targetType: "field",
                targetId: fkField.id,
                tableName: fkTable.name,
                fieldName: fkField.name,
                message: `Foreign key column "${fkTable.name}"."${fkField.name}" has no index.`,
                suggestion: `Create an index on "${fkTable.name}"("${fkField.name}") to prevent full-table scans during JOIN queries and parent row deletions.`,
                fixable: true,
                fixDescription: `Create index idx_${fkTable.name}_${fkField.name} on "${fkTable.name}"("${fkField.name}")`,
                fix: (db: DatabaseType) => {
                    const cloned = cloneDeep(db);
                    const target = cloned.tables.find(t => t.id === fkTable.id);
                    if (target) {
                        const indexId = `idx_${target.name}_${fkField.name}_${Date.now()}`;
                        const fieldIndexId = `fi_${indexId}_1`;
                        const newIndex: IndexType = {
                            id: indexId,
                            tableId: target.id,
                            name: `idx_${target.name}_${fkField.name}`,
                            unique: false,
                            fieldIndices: [{
                                id: fieldIndexId,
                                indexId,
                                fieldId: fkField.id,
                                sequence: 0,
                            } as any],
                            fields: [fkField],
                        } as IndexType;
                        target.indices = target.indices ?? [];
                        target.indices.push(newIndex);
                    }
                    return cloned;
                }
            });
        }
    }
    return issues;
}

/** Check 3: Reserved SQL Keyword Collisions */
export function checkReservedKeywordCollisions(database: DatabaseType, options?: LinterOptions): LintIssue[] {
    const issues: LintIssue[] = [];

    for (const table of database.tables ?? []) {
        if (SQL_RESERVED_WORDS.has(table.name.toLowerCase())) {
            issues.push({
                id: `reserved-word-table-${table.id}`,
                ruleId: "reserved-keyword-collision",
                ruleName: "Avoid Reserved Keywords",
                category: "naming",
                severity: options?.severityOverrides?.["reserved-keyword-collision"] ?? "error",
                targetType: "table",
                targetId: table.id,
                tableName: table.name,
                message: `Table name "${table.name}" is a reserved SQL keyword.`,
                suggestion: `Rename table to avoid collisions (e.g., "${table.name}s", "app_${table.name}", or "${table.name}_record").`,
                fixable: true,
                fixDescription: `Pluralize table name to "${table.name}s"`,
                fix: (db: DatabaseType) => {
                    const cloned = cloneDeep(db);
                    const target = cloned.tables.find(t => t.id === table.id);
                    if (target) target.name = `${target.name}s`;
                    return cloned;
                }
            });
        }

        for (const field of table.fields) {
            if (SQL_RESERVED_WORDS.has(field.name.toLowerCase())) {
                issues.push({
                    id: `reserved-word-field-${field.id}`,
                    ruleId: "reserved-keyword-collision",
                    ruleName: "Avoid Reserved Keywords",
                    category: "naming",
                    severity: options?.severityOverrides?.["reserved-keyword-collision"] ?? "warning",
                    targetType: "field",
                    targetId: field.id,
                    tableName: table.name,
                    fieldName: field.name,
                    message: `Column "${table.name}"."${field.name}" uses reserved SQL keyword "${field.name}".`,
                    suggestion: `Prefix or clarify column name (e.g., "${table.name.toLowerCase()}_${field.name}" or "${field.name}_val").`,
                    fixable: true,
                    fixDescription: `Prefix column name to "${table.name.toLowerCase()}_${field.name}"`,
                    fix: (db: DatabaseType) => {
                        const cloned = cloneDeep(db);
                        const targetT = cloned.tables.find(t => t.id === table.id);
                        const targetF = targetT?.fields.find(f => f.id === field.id);
                        if (targetF && targetT) targetF.name = `${targetT.name.toLowerCase()}_${targetF.name}`;
                        return cloned;
                    }
                });
            }
        }
    }
    return issues;
}

/** Check 4: Naming convention compliance (default snake_case) */
export function checkNamingConventions(database: DatabaseType, options?: LinterOptions): LintIssue[] {
    const issues: LintIssue[] = [];
    const convention = options?.namingConvention ?? "snake_case";
    if (convention === "any") return issues;

    for (const table of database.tables ?? []) {
        if (!matchesConvention(table.name, convention)) {
            const expectedName = convention === "snake_case" ? toSnakeCase(table.name) : toCamelCase(table.name);
            issues.push({
                id: `naming-table-${table.id}`,
                ruleId: "table-naming-convention",
                ruleName: "Table Naming Convention",
                category: "naming",
                severity: options?.severityOverrides?.["table-naming-convention"] ?? "warning",
                targetType: "table",
                targetId: table.id,
                tableName: table.name,
                message: `Table "${table.name}" does not adhere to ${convention} convention.`,
                suggestion: `Rename table to "${expectedName}".`,
                fixable: true,
                fixDescription: `Rename to "${expectedName}"`,
                fix: (db: DatabaseType) => {
                    const cloned = cloneDeep(db);
                    const target = cloned.tables.find(t => t.id === table.id);
                    if (target) target.name = expectedName;
                    return cloned;
                }
            });
        }

        for (const field of table.fields) {
            if (!matchesConvention(field.name, convention)) {
                const expectedName = convention === "snake_case" ? toSnakeCase(field.name) : toCamelCase(field.name);
                issues.push({
                    id: `naming-field-${field.id}`,
                    ruleId: "column-naming-convention",
                    ruleName: "Column Naming Convention",
                    category: "naming",
                    severity: options?.severityOverrides?.["column-naming-convention"] ?? "warning",
                    targetType: "field",
                    targetId: field.id,
                    tableName: table.name,
                    fieldName: field.name,
                    message: `Column "${table.name}"."${field.name}" does not adhere to ${convention} convention.`,
                    suggestion: `Rename column to "${expectedName}".`,
                    fixable: true,
                    fixDescription: `Rename to "${expectedName}"`,
                    fix: (db: DatabaseType) => {
                        const cloned = cloneDeep(db);
                        const targetT = cloned.tables.find(t => t.id === table.id);
                        const targetF = targetT?.fields.find(f => f.id === field.id);
                        if (targetF) targetF.name = expectedName;
                        return cloned;
                    }
                });
            }
        }
    }
    return issues;
}

/** Check 5: Redundant / Duplicate indexes */
export function checkRedundantIndexes(database: DatabaseType, options?: LinterOptions): LintIssue[] {
    const issues: LintIssue[] = [];

    for (const table of database.tables ?? []) {
        const indices = table.indices ?? [];
        if (indices.length <= 1) continue;

        for (let i = 0; i < indices.length; i++) {
            const idxA = indices[i];
            const colsA = (idxA.fieldIndices ?? []).map(fi => fi.fieldId);
            if (colsA.length === 0) continue;

            for (let j = i + 1; j < indices.length; j++) {
                const idxB = indices[j];
                const colsB = (idxB.fieldIndices ?? []).map(fi => fi.fieldId);
                if (colsB.length === 0) continue;

                // Exact duplicate
                if (colsA.length === colsB.length && colsA.every((c, k) => c === colsB[k])) {
                    issues.push({
                        id: `duplicate-index-${idxB.id}`,
                        ruleId: "redundant-index",
                        ruleName: "Duplicate Index",
                        category: "performance",
                        severity: options?.severityOverrides?.["redundant-index"] ?? "warning",
                        targetType: "index",
                        targetId: idxB.id,
                        tableName: table.name,
                        message: `Index "${idxB.name}" is an exact duplicate of "${idxA.name}".`,
                        suggestion: `Drop redundant index "${idxB.name}" to save storage and disk write I/O.`,
                        fixable: true,
                        fixDescription: `Remove duplicate index "${idxB.name}"`,
                        fix: (db: DatabaseType) => {
                            const cloned = cloneDeep(db);
                            const target = cloned.tables.find(t => t.id === table.id);
                            if (target && target.indices) {
                                target.indices = target.indices.filter(idx => idx.id !== idxB.id);
                            }
                            return cloned;
                        }
                    });
                }
            }
        }
    }
    return issues;
}

/** Check 6: Missing Documentation / Notes */
export function checkMissingDocumentation(database: DatabaseType, options?: LinterOptions): LintIssue[] {
    if (options?.checkDocumentation === false) return [];
    const issues: LintIssue[] = [];

    for (const table of database.tables ?? []) {
        if (!table.note || table.note.trim().length === 0) {
            issues.push({
                id: `missing-note-table-${table.id}`,
                ruleId: "missing-documentation",
                ruleName: "Missing Table Documentation",
                category: "documentation",
                severity: options?.severityOverrides?.["missing-documentation"] ?? "info",
                targetType: "table",
                targetId: table.id,
                tableName: table.name,
                message: `Table "${table.name}" lacks descriptive documentation/notes.`,
                suggestion: "Add a short note explaining the domain entity or business purpose represented by this table.",
                fixable: false,
            });
        }
    }
    return issues;
}
