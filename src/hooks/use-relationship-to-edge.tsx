
import { RelationshipType } from "@/lib/schemas/relationship-schema";
import { LEFT_PREFIX, TARGET_PREFIX } from "@/features/database/components/field";
import { Edge, useReactFlow } from "@xyflow/react";
import { useEffect } from "react";
import { AiDiffStatus } from "@/lib/ai-diagram-preview";

export const useRelationshipToEdge = (relationships: RelationshipType[], statuses?: Record<string, AiDiffStatus>): void => {
    const { setEdges } = useReactFlow();
    useEffect(() => {

        const edges = relationships.map((relationship: RelationshipType) => {
            return {
                id: relationship.id,
                source: relationship.sourceTableId,
                sourceHandle: LEFT_PREFIX + relationship.sourceFieldId,
                target: relationship.targetTableId,
                targetHandle: TARGET_PREFIX + relationship.targetFieldId,
                selected: false , 
                animated : false , 
                data: {
                    relationship,
                    aiDiffStatus: statuses?.[relationship.id],
                }
            } as Edge
        })

        setEdges(edges);
    }, [relationships, statuses])

}
