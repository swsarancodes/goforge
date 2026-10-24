import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { Risk } from "@/lib/schema-change-api";

const RISK_STYLE: Record<Risk, string> = {
    low: "border-border text-muted-foreground",
    medium: "border-foreground/40 text-foreground",
    high: "border-destructive bg-destructive/10 text-destructive",
};

export const RiskBadge: React.FC<{ risk: Risk }> = ({ risk }) => (
    <Badge variant="outline" className={cn("shrink-0 text-[10px] uppercase", RISK_STYLE[risk])}>
        {risk}
    </Badge>
);
