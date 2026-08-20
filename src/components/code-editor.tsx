import React, { useEffect, useState } from "react";
import { useTheme } from "@/providers/theme-provider/theme-provider";
import { cn } from "@/lib/utils";
import { Spinner } from "./ui/shadcn-io/spinner";

interface CodeEditorProps {
    defaultValue?: string;
    value?: string;
    className?: string | undefined,
    readOnly?: boolean,
    onChange?: (sql: string) => void
    autoFocus?: boolean,
}

const CodeEditor: React.FC<CodeEditorProps> = ({
    defaultValue,
    value,
    className,
    readOnly = false,
    onChange,
    autoFocus = false,
}) => {


    const [editor, setEditor] = useState<any>(null);

    useEffect(() => {

        let mounted = true;

        Promise.all([
            import("@uiw/react-codemirror"),
            import("@codemirror/lang-sql"),
            import("@codemirror/view"),
        ]).then(([cm, sqlLang, view]) => {

            if (!mounted) return;

            const overrideDarkTheme = view.EditorView.theme({

                '.cm-content': {
                    backgroundColor: "#1c2025",
                },
                ".cm-gutter": {
                    backgroundColor: "#1c2025",
                },

                ".cm-gutterElement": {
                    color: "#4b515a"
                },

                ".ͼp": {
                    color: "#A994FF"
                },

                ".cm-line .ͼq": {
                    color: "#ff6363"
                },
                ".ͼu": {
                    color: "#B6E672"
                },
                ".ͼv": {
                    color: "#6cdcc4"
                }
            }, { dark: true });

            const overrideLightTheme = view.EditorView.theme({

                ".ͼb": {
                    color: "#2A1D66"
                },
                ".cm-content": {
                    backgroundColor: "#ffffff",
                },
                ".cm-gutterElement": {
                    color: "#62748e"
                },
                ".cm-gutter": {
                    // Slightly off-white so the gutter reads as separate from
                    // the white content area, matching the light theme surfaces.
                    backgroundColor: "#f8fafc",

                },
                ".cm-gutters": {
                    borderColor: "#e2e8f0"
                },
                ".cm-line": {
                    color: "#0f172b"
                },

            })
            setEditor({
                CodeMirror: cm.default,
                oneDark: cm.oneDark,
                sql: sqlLang.sql,
                overrideDarkTheme,
                overrideLightTheme,
            });
        });

        return () => {
            mounted = false;
        };
    }, []);


    const { theme } = useTheme();

    if (!editor) {
        return (
            <div
                className={cn(
                    "flex flex-1 w-full min-h-9 rounded-sm border border-border bg-card items-center justify-center",
                    className
                )}
            >
                <Spinner className="text-primary" />
            </div>
        );
    }

    const { CodeMirror, oneDark, sql, overrideDarkTheme, overrideLightTheme } = editor;
    return (
        <CodeMirror
            defaultValue={defaultValue}
            value={value}
            className={cn("flex flex-1 w-full min-h-9 rounded-sm  h-full   bg-card border-1 border-border  !min-w-0 overflow-hidden", className)}
            extensions={[sql()]}
            readOnly={readOnly}
            autoFocus={autoFocus}
            theme={theme != "dark" ? overrideLightTheme : [oneDark, overrideDarkTheme]}
            onChange={onChange}
        />
    )
}


export default React.memo(CodeEditor); 