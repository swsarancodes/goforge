import React, { useEffect, useState } from "react";
import { useTheme } from "@/providers/theme-provider/theme-provider";
import { cn } from "@/lib/utils";
import { Spinner } from "./ui/shadcn-io/spinner";

const createEditorRuntime = async () => {
    const [codeMirror, sqlLanguage, view] = await Promise.all([import("@uiw/react-codemirror"), import("@codemirror/lang-sql"), import("@codemirror/view")]);

    const darkOverride = view.EditorView.theme(
        {
            ".cm-content": { backgroundColor: "#1c2025" },
            ".cm-gutter": { backgroundColor: "#1c2025" },
            ".cm-gutterElement": { color: "#4b515a" },
            ".ͼp": { color: "#A994FF" },
            ".cm-line .ͼq": { color: "#ff6363" },
            ".ͼu": { color: "#B6E672" },
            ".ͼv": { color: "#6cdcc4" },
        },
        { dark: true },
    );

    const lightTheme = view.EditorView.theme({
        ".ͼb": { color: "#2A1D66" },
        ".cm-content": { backgroundColor: "#ffffff" },
        ".cm-gutterElement": { color: "#62748e" },
        ".cm-gutter": { backgroundColor: "#f8fafc" },
        ".cm-gutters": { borderColor: "#e2e8f0" },
        ".cm-line": { color: "#0f172b" },
    });

    const editorKeyBoundary = view.EditorView.domEventHandlers({
        keydown: (event) => {
            // Keep editor editing shortcuts inside CodeMirror. Returning false
            // lets CodeMirror continue handling selection and deletion normally.
            event.stopPropagation();
            return false;
        },
    });

    return {
        CodeMirror: codeMirror.default,
        extensions: [sqlLanguage.sql(), editorKeyBoundary],
        darkTheme: [codeMirror.oneDark, darkOverride],
        lightTheme,
    };
};

type EditorRuntime = Awaited<ReturnType<typeof createEditorRuntime>>;
let editorRuntimePromise: Promise<EditorRuntime> | undefined;

const loadEditorRuntime = () => {
    editorRuntimePromise ??= createEditorRuntime();
    return editorRuntimePromise;
};

interface CodeEditorProps {
    defaultValue?: string;
    value?: string;
    className?: string | undefined;
    readOnly?: boolean;
    onChange?: (sql: string) => void;
    autoFocus?: boolean;
}

const CodeEditor: React.FC<CodeEditorProps> = ({ defaultValue, value, className, readOnly = false, onChange, autoFocus = false }) => {
    const [editor, setEditor] = useState<EditorRuntime | null>(null);

    useEffect(() => {
        let mounted = true;

        loadEditorRuntime().then((runtime) => {
            if (mounted) setEditor(runtime);
        });

        return () => {
            mounted = false;
        };
    }, []);

    const { theme } = useTheme();

    if (!editor) {
        return (
            <div className={cn("flex flex-1 w-full min-h-9 rounded-sm border border-border bg-card items-center justify-center", className)}>
                <Spinner className="text-primary" />
            </div>
        );
    }

    const { CodeMirror, extensions, darkTheme, lightTheme } = editor;
    return (
        <CodeMirror
            value={value ?? defaultValue ?? ""}
            className={cn("flex flex-1 w-full min-h-9 rounded-sm  h-full   bg-card border-1 border-border  !min-w-0 overflow-hidden", className)}
            extensions={extensions}
            readOnly={readOnly}
            autoFocus={autoFocus}
            onCreateEditor={(view) => {
                // The editor is loaded asynchronously, so CodeMirror's native
                // autoFocus can run before its contenteditable exists. Focus it
                // explicitly once the editor has been created so select-all,
                // paste, and delete operate on SQL text.
                if (autoFocus) view.focus();
            }}
            onKeyDown={(event) => {
                // CodeMirror handles native editing at the contenteditable
                // target. Stop the event at the editor boundary so canvas and
                // window-level shortcuts cannot intercept Cmd/Ctrl+A, delete,
                // word deletion, or line deletion.
                if (event.target instanceof HTMLElement && event.target.closest(".cm-content")) {
                    event.stopPropagation();
                }
            }}
            theme={theme !== "dark" ? lightTheme : darkTheme}
            onChange={onChange}
        />
    );
};

export default React.memo(CodeEditor);
