import { describe, expect, it } from "vitest";
import { DatabaseDialect } from "@/lib/database";
import { Cardinality } from "@/lib/schemas/relationship-schema";
import { DataType } from "@/lib/schemas/data-type-schema";
import { toDrawio } from "./to-drawio";
import { parseDrawio } from "./from-drawio";

const MOCK_DATA_TYPES: DataType[] = [
    { id: "dt-uuid", name: "uuid", dialect: DatabaseDialect.POSTGRES } as any,
    { id: "dt-varchar", name: "varchar", dialect: DatabaseDialect.POSTGRES } as any,
    { id: "dt-int", name: "integer", dialect: DatabaseDialect.POSTGRES } as any,
    { id: "dt-text", name: "text", dialect: DatabaseDialect.POSTGRES } as any,
];

describe("Draw.io XML Generator & Parser", () => {
    it("generates well-formed Draw.io XML for a schema with tables and relationships", () => {
        const mockDatabase: any = {
            name: "Commerce App",
            dialect: DatabaseDialect.POSTGRES,
            tables: [
                {
                    id: "tbl-users",
                    name: "users",
                    namespace: "auth",
                    posX: 120,
                    posY: 180,
                    width: 260,
                    fields: [
                        { id: "fld-u-1", name: "id", type: { name: "uuid" }, isPrimary: true, isNullable: false },
                        { id: "fld-u-2", name: "email", type: { name: "varchar" }, isPrimary: false, isUnique: true, isNullable: false },
                    ],
                },
                {
                    id: "tbl-orders",
                    name: "orders",
                    namespace: "public",
                    posX: 480,
                    posY: 180,
                    width: 260,
                    fields: [
                        { id: "fld-o-1", name: "id", type: { name: "uuid" }, isPrimary: true, isNullable: false },
                        { id: "fld-o-2", name: "user_id", type: { name: "uuid" }, isPrimary: false, isNullable: false },
                        { id: "fld-o-3", name: "amount", type: { name: "integer" }, isPrimary: false, isNullable: true },
                    ],
                },
            ],
            relationships: [
                {
                    id: "rel-users-orders",
                    name: "fk_orders_user",
                    sourceTableId: "tbl-users",
                    targetTableId: "tbl-orders",
                    sourceFieldId: "fld-u-1",
                    targetFieldId: "fld-o-2",
                    cardinality: Cardinality.one_to_many,
                },
            ],
        };

        const result = toDrawio(mockDatabase, { pageName: "Schema Diagram" });
        expect(result.warnings).toHaveLength(0);
        expect(result.xml).toContain("<mxfile");
        expect(result.xml).toContain('<diagram id="');
        expect(result.xml).toContain('name="Schema Diagram"');
        expect(result.xml).toContain('value="auth.users"');
        expect(result.xml).toContain('value="public.orders"');
        expect(result.xml).toContain('value="id: uuid [PK]"');
        expect(result.xml).toContain('value="email: varchar [UQ, NN]"');
        expect(result.xml).toContain('source="table_tbl-users"');
        expect(result.xml).toContain('target="table_tbl-orders"');
        expect(result.xml).toContain("startArrow=ERone");
        expect(result.xml).toContain("endArrow=ERmany");
    });

    it("parses Draw.io XML into a canonical GoForge ProjectFile", () => {
        const drawioXml = `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net" version="24.0.0">
  <diagram id="d1" name="Page-1">
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="t_cust" value="customers" style="swimlane;childLayout=stackLayout;" vertex="1" parent="1">
          <mxGeometry x="100" y="150" width="220" height="90" as="geometry" />
        </mxCell>
        <mxCell id="c_id" value="+ id: uuid [PK]" style="text;" vertex="1" parent="t_cust">
          <mxGeometry y="28" width="220" height="26" as="geometry" />
        </mxCell>
        <mxCell id="c_email" value="email: varchar [NN]" style="text;" vertex="1" parent="t_cust">
          <mxGeometry y="54" width="220" height="26" as="geometry" />
        </mxCell>
        <mxCell id="t_inv" value="invoices" style="swimlane;childLayout=stackLayout;" vertex="1" parent="1">
          <mxGeometry x="400" y="150" width="220" height="90" as="geometry" />
        </mxCell>
        <mxCell id="i_id" value="+ id: uuid [PK]" style="text;" vertex="1" parent="t_inv">
          <mxGeometry y="28" width="220" height="26" as="geometry" />
        </mxCell>
        <mxCell id="i_cust" value="customer_id: uuid [NN]" style="text;" vertex="1" parent="t_inv">
          <mxGeometry y="54" width="220" height="26" as="geometry" />
        </mxCell>
        <mxCell id="rel_1" value="fk_invoices_cust" style="edgeStyle=orthogonalEdgeStyle;startArrow=ERone;endArrow=ERmany;" edge="1" parent="1" source="t_cust" target="t_inv">
          <mxGeometry relative="1" as="geometry" />
        </mxCell>
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

        const parsed = parseDrawio(drawioXml, {
            dialect: DatabaseDialect.POSTGRES,
            dataTypes: MOCK_DATA_TYPES,
            fallbackName: "Imported Invoices",
        });

        expect(parsed.file.project.name).toBe("Imported Invoices");
        expect(parsed.file.project.tables).toHaveLength(2);

        const custTable = parsed.file.project.tables.find((t) => t.name === "customers");
        expect(custTable).toBeDefined();
        expect(custTable?.fields).toHaveLength(2);
        expect(custTable?.fields[0].name).toBe("id");
        expect(custTable?.fields[0].isPrimary).toBe(true);
        expect(custTable?.fields[1].name).toBe("email");
        expect(custTable?.fields[1].isNullable).toBe(false);

        const invTable = parsed.file.project.tables.find((t) => t.name === "invoices");
        expect(invTable).toBeDefined();

        expect(parsed.file.project.relationships).toHaveLength(1);
        expect(parsed.file.project.relationships[0].cardinality).toBe(Cardinality.one_to_many);
    });

    it("survives export and import round-trip without losing tables, columns, or relationships", () => {
        const originalDatabase: any = {
            name: "RoundTrip App",
            dialect: DatabaseDialect.POSTGRES,
            tables: [
                {
                    id: "tbl_products",
                    name: "products",
                    posX: 50,
                    posY: 80,
                    width: 250,
                    fields: [
                        { id: "fld_p1", name: "sku", type: { name: "varchar" }, isPrimary: true, isNullable: false },
                        { id: "fld_p2", name: "price", type: { name: "integer" }, isPrimary: false, isNullable: false },
                    ],
                },
                {
                    id: "tbl_inventory",
                    name: "inventory",
                    posX: 400,
                    posY: 80,
                    width: 250,
                    fields: [
                        { id: "fld_i1", name: "id", type: { name: "uuid" }, isPrimary: true, isNullable: false },
                        { id: "fld_i2", name: "sku", type: { name: "varchar" }, isPrimary: false, isNullable: false },
                    ],
                },
            ],
            relationships: [
                {
                    id: "rel_inv_prod",
                    name: "fk_inventory_products",
                    sourceTableId: "tbl_products",
                    targetTableId: "tbl_inventory",
                    cardinality: Cardinality.one_to_many,
                },
            ],
        };

        const exported = toDrawio(originalDatabase);
        const imported = parseDrawio(exported.xml, {
            dialect: DatabaseDialect.POSTGRES,
            dataTypes: MOCK_DATA_TYPES,
            fallbackName: "RoundTrip App",
        });

        expect(imported.file.project.tables).toHaveLength(2);
        const tableNames = imported.file.project.tables.map((t) => t.name).sort();
        expect(tableNames).toEqual(["inventory", "products"]);

        const products = imported.file.project.tables.find((t) => t.name === "products")!;
        expect(products.fields.find((f) => f.name === "sku")?.isPrimary).toBe(true);

        expect(imported.file.project.relationships).toHaveLength(1);
    });

    it("parses HTML-formatted cells created by Draw.io rich text editor", () => {
        const richXml = `<mxfile>
  <diagram id="d1">
    <mxGraphModel>
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
        <mxCell id="t1" value="&lt;b&gt;billing.accounts&lt;/b&gt;" style="swimlane;" vertex="1" parent="1">
          <mxGeometry x="100" y="100" width="200" height="60" as="geometry" />
        </mxCell>
        <mxCell id="f1" value="&lt;span style=&quot;color: red;&quot;&gt;+ account_id: uuid [PK]&lt;/span&gt;" vertex="1" parent="t1" />
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;

        const parsed = parseDrawio(richXml, {
            dialect: DatabaseDialect.POSTGRES,
            dataTypes: MOCK_DATA_TYPES,
        });

        expect(parsed.file.project.tables).toHaveLength(1);
        const table = parsed.file.project.tables[0];
        expect(table.name).toBe("accounts");
        expect(table.namespace).toBe("billing");
        expect(table.fields[0].name).toBe("account_id");
        expect(table.fields[0].isPrimary).toBe(true);
    });

    it("parses raw mxGraphModel XML without outer mxfile tag", () => {
        const rawModelXml = `<mxGraphModel>
  <root>
    <mxCell id="0" />
    <mxCell id="1" parent="0" />
    <mxCell id="t_posts" value="posts" style="swimlane;" vertex="1" parent="1">
      <mxGeometry x="50" y="50" width="200" height="60" as="geometry" />
    </mxCell>
    <mxCell id="c_pid" value="id: uuid [PK]" vertex="1" parent="t_posts" />
  </root>
</mxGraphModel>`;

        const parsed = parseDrawio(rawModelXml, {
            dialect: DatabaseDialect.POSTGRES,
            dataTypes: MOCK_DATA_TYPES,
            fallbackName: "Standalone Model",
        });

        expect(parsed.file.project.tables).toHaveLength(1);
        expect(parsed.file.project.tables[0].name).toBe("posts");
        expect(parsed.file.project.tables[0].fields[0].name).toBe("id");
        expect(parsed.file.project.tables[0].fields[0].isPrimary).toBe(true);
    });

    it("handles empty schema gracefully", () => {
        const emptyDb: any = {
            name: "Empty DB",
            dialect: DatabaseDialect.POSTGRES,
            tables: [],
            relationships: [],
        };

        const exported = toDrawio(emptyDb);
        expect(exported.xml).toContain("<mxfile");
        expect(exported.warnings).toHaveLength(0);

        const imported = parseDrawio(exported.xml, {
            dataTypes: MOCK_DATA_TYPES,
        });
        expect(imported.file.project.tables).toHaveLength(0);
        expect(imported.file.project.relationships).toHaveLength(0);
    });
});
