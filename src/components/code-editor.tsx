import React, { useEffect, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { useTheme } from "@/providers/theme-provider/theme-provider";
import { cn } from "@/lib/utils";
import { Spinner } from "./ui/shadcn-io/spinner";

const createEditorRuntime = async () => {
    const [codeMirror, sqlLanguage, view, commands, state] = await Promise.all([
        import("@uiw/react-codemirror"),
        import("@codemirror/lang-sql"),
        import("@codemirror/view"),
        import("@codemirror/commands"),
        import("@codemirror/state"),
    ]);

    const darkOverride = view.EditorView.theme(
        {
            ".cm-content": { backgroundColor: "#1c2025" },
            ".cm-gutter": { backgroundColor: "#1c2025" },
            ".cm-gutterElement": { color: "#4b515a" },
            // Blue selection highlight - the default grey is nearly invisible.
            ".cm-selectionBackground": { backgroundColor: "#264f78 !important" },
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
        // Blue selection highlight - the default grey is nearly invisible.
        ".cm-selectionBackground": { backgroundColor: "#b3d7ff !important" },
    });

    const editorKeyBoundary = view.EditorView.domEventHandlers({
        keydown: (event) => {
            // Keep editor editing shortcuts inside CodeMirror. Returning false
            // lets CodeMirror continue handling selection and deletion normally.
            event.stopPropagation();
            return false;
        },
    });

    const selectedText = (editorView: EditorView) =>
        editorView.state.selection.ranges
            .filter((range) => !range.empty)
            .map((range) => editorView.state.sliceDoc(range.from, range.to))
            .join("\n");

    /**
     * On macOS CodeMirror maps Ctrl+A/E/K... to their Emacs meanings
     * (Ctrl+A = start of line) and the browser's clipboard shortcuts are
     * Cmd-only, so Ctrl+A/C/X/V/Z/Y do nothing useful there. Bind them here
     * as mac-only keymap entries. Same-key bindings run in registration
     * order, and basicSetup (with the Emacs defaults) is registered first,
     * so this needs Prec.high to win. Cmd+key keeps working through
     * CodeMirror's standard bindings.
     */
    const macCtrlKeymap = state.Prec.high(
        view.keymap.of([
        { mac: "Ctrl-a", run: commands.selectAll },
        {
            mac: "Ctrl-c",
            run: (editorView) => {
                const text = selectedText(editorView);
                if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
                return true;
            },
        },
        {
            mac: "Ctrl-x",
            run: (editorView) => {
                const text = selectedText(editorView);
                if (!text || editorView.state.readOnly) return true;
                void navigator.clipboard?.writeText(text).catch(() => undefined);
                editorView.dispatch({ ...editorView.state.replaceSelection(""), userEvent: "delete.cut", scrollIntoView: true });
                return true;
            },
        },
        {
            mac: "Ctrl-v",
            run: (editorView) => {
                if (editorView.state.readOnly) return true;
                void navigator.clipboard?.readText().then((text) => {
                    editorView.dispatch({ ...editorView.state.replaceSelection(text), userEvent: "input.paste", scrollIntoView: true });
                }).catch(() => undefined);
                return true;
            },
        },
        { mac: "Ctrl-z", run: commands.undo },
        { mac: "Shift-Ctrl-z", run: commands.redo },
        { mac: "Ctrl-y", run: commands.redo },
        ]),
    );

    return {
        CodeMirror: codeMirror.default,
        extensions: [sqlLanguage.sql(), editorKeyBoundary, macCtrlKeymap],
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
            // The app disables text selection globally (html, body {
            // user-select: none }) for canvas dragging. The editor opts back
            // in via `selectable` - without it, drag-select, Cmd/Ctrl+A and
            // copy are all suppressed inside the SQL text.
            className={cn("selectable flex flex-1 w-full min-h-9 rounded-sm  h-full   bg-card border-1 border-border  !min-w-0 overflow-hidden", className)}
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
