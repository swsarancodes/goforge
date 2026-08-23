
import { TableType } from "@/lib/schemas/table-schema";
import { Node, useReactFlow } from "@xyflow/react";
import { useEffect } from "react";
import { getDefaultTableOverlapping } from "@/utils/tables";
import hash from "object-hash";
import { AiDiagramPreview } from "@/lib/ai-diagram-preview";



export const useTableToNode = (tables: TableType[], aiPreview?: AiDiagramPreview): void => {
    const { setNodes } = useReactFlow();
    
    useEffect(() => {     
        
        const tableNodes = tables.map((table: TableType) => {
            return {
                id: table.id,
                type: "table",
                position: {
                    x: table.posX,
                    y: table.posY
                },
                data: {
                    table,
                    overlapping: getDefaultTableOverlapping(table, tables),
                    pulsing: false,
                    highlightedEdges: [],
                    aiPreviewActive: Boolean(aiPreview),
                    aiDiffStatus: aiPreview?.tableStatuses[table.id],
                    aiFieldStatuses: aiPreview?.fieldStatuses ?? {},
                },
                style: {
                    width: 224
                }
            } as Node
        }) ; 

        setNodes((nodes) => {
            return tableNodes.map((tableNode) => {
                const node: Node | undefined = nodes.find((node: Node) => node.id == tableNode.id);
                
                if (!node)
                    return tableNode;
                else {
                    const hashNode: string = hash({
                        table: node.data.table as TableType,
                        aiPreviewActive: node.data.aiPreviewActive,
                        aiDiffStatus: node.data.aiDiffStatus,
                        aiFieldStatuses: node.data.aiFieldStatuses,
                    });
                    const hashTableNode: string = hash({
                        table: tableNode.data.table as TableType,
                        aiPreviewActive: tableNode.data.aiPreviewActive,
                        aiDiffStatus: tableNode.data.aiDiffStatus,
                        aiFieldStatuses: tableNode.data.aiFieldStatuses,
                    });
                
                    return hashNode == hashTableNode
                        ? node
                        : { ...tableNode, selected: node.selected, data: { ...tableNode.data, highlightedEdges: node.data.highlightedEdges ?? [] } };
                }
            })
        }); 
        
    }, [tables, aiPreview])

}
