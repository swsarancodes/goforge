import React, { useMemo } from "react";
import { cn } from "@/lib/utils";
import { diffLines } from "../line-diff";

/** The original and the converted query, line by line. */
export const CompareView: React.FC<{ original: string; converted: string }> = ({ original, converted }) => {
    const lines = useMemo(() => diffLines(original, converted), [original, converted]);
    const added = lines.filter((line) => line.type === "added").length;
    const removed = lines.filter((line) => line.type === "removed").length;

    return (
        <div className="flex flex-col gap-2 p-1">
            <p className="px-1 text-[11px] text-muted-foreground">
                {removed} line{removed === 1 ? "" : "s"} removed, {added} added. Unchanged lines are shown in grey.
            </p>
            <pre className="overflow-x-auto rounded-lg border bg-card p-2 font-mono text-[11px] leading-relaxed">
                {lines.map((line, index) => (
                    <div key={index} className={cn("whitespace-pre px-1", line.type === "added" && "bg-emerald-500/10 text-emerald-800 dark:text-emerald-300", line.type === "removed" && "bg-rose-500/10 text-rose-800 dark:text-rose-300", line.type === "same" && "text-muted-foreground")}>
                        <span className="select-none opacity-60">{line.type === "added" ? "+ " : line.type === "removed" ? "− " : "  "}</span>
                        {line.text || " "}
                    </div>
                ))}
            </pre>
        </div>
    );
};
