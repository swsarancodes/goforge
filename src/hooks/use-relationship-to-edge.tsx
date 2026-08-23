
import { RelationshipType } from "@/lib/schemas/relationship-schema";
import { LEFT_PREFIX, TARGET_PREFIX } from "@/features/database/components/field";
import { Edge, useReactFlow } from "@xyflow/react";
import { useEffect } from "react";
import { AiDiffStatus } from "@/lib/ai-diagram-preview";

export const useRelationshipToEdge = (relationships: RelationshipType[], statuses?: Record<string, AiDiffStatus>): void => {
    const { setEdges } = useReactFlow();
    useEffect(() => {

        setEdges((currentEdges) => {
            const currentById = new Map(currentEdges.map((edge) => [edge.id, edge]));
            let changed = currentEdges.length !== relationships.length;
            const edges = relationships.map((relationship: RelationshipType) => {
                const current = currentById.get(relationship.id);
                const aiDiffStatus = statuses?.[relationship.id];
                if (current?.data?.relationship === relationship && current.data.aiDiffStatus === aiDiffStatus) {
                    return current;
                }
                changed = true;
                return {
                    id: relationship.id,
                    source: relationship.sourceTableId,
                    sourceHandle: LEFT_PREFIX + relationship.sourceFieldId,
                    target: relationship.targetTableId,
                    targetHandle: TARGET_PREFIX + relationship.targetFieldId,
                    selected: current?.selected ?? false,
                    animated: current?.animated ?? false,
                    data: {
                        relationship,
                        aiDiffStatus,
                    },
                } as Edge;
            });

            return changed ? edges : currentEdges;
        });
    }, [relationships, setEdges, statuses]);
};
