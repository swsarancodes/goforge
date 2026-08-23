import { TableType } from "@/lib/schemas/table-schema";
import { Node, useReactFlow } from "@xyflow/react";
import { useEffect } from "react";
import { getDefaultTableOverlapping } from "@/utils/tables";
import hash from "object-hash";
import { AiDiagramPreview, AiDiffStatus } from "@/lib/ai-diagram-preview";
export const useTableToNode = (tables: TableType[], aiPreview?: AiDiagramPreview): void => {
    const { setNodes } = useReactFlow();

    useEffect(() => {
        const tableNodes = tables.map((table: TableType) => {
            const aiFieldStatuses = aiPreview
                ? Object.fromEntries(
                    table.fields
                        .map((field) => [field.id, aiPreview.fieldStatuses[field.id]] as const)
                        .filter((entry): entry is readonly [string, AiDiffStatus] => Boolean(entry[1])),
                )
                : {};
            const syncKey = hash({
                table,
                aiPreviewActive: Boolean(aiPreview),
                aiDiffStatus: aiPreview?.tableStatuses[table.id],
                aiFieldStatuses,
            });
            return {
                id: table.id,
                type: "table",
                position: {
                    x: table.posX,
                    y: table.posY,
                },
                data: {
                    table,
                    overlapping: getDefaultTableOverlapping(table, tables),
                    pulsing: false,
                    highlightedEdges: [],
                    aiPreviewActive: Boolean(aiPreview),
                    aiDiffStatus: aiPreview?.tableStatuses[table.id],
                    aiFieldStatuses,
                    syncKey,
                },
                style: {
                    width: 224,
                },
            } as Node;
        });

        setNodes((nodes) => {
            const nodesById = new Map(nodes.map((node) => [node.id, node]));
            return tableNodes.map((tableNode) => {
                const node: Node | undefined = nodesById.get(tableNode.id);
                
                if (!node) return tableNode;
                return node.data.syncKey === tableNode.data.syncKey
                    ? node
                    : {
                        ...tableNode,
                        selected: node.selected,
                        data: {
                            ...tableNode.data,
                            highlightedEdges: node.data.highlightedEdges ?? [],
                        },
                    };
            });
        });
    }, [tables, aiPreview, setNodes]);
};
