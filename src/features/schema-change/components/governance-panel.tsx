import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { AiSettings, AiStatus, AuditEntry, OpenAiModel, auditExportUrl, fetchAiSettings, fetchAudit, fetchAuditEntry, fetchOpenAiModels, saveAiSettings, testAiSettings } from "@/lib/schema-change-api";
import { formatCount, formatTime } from "../format";

const lines = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

const Field: React.FC<{ label: string; hint?: string; htmlFor?: string; children: React.ReactNode }> = ({ label, hint, htmlFor, children }) => (
    <div className="space-y-1">
        <Label htmlFor={htmlFor} className="text-xs">{label}</Label>
        {children}
        {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </div>
);

/** Which OpenAI model is used and which models may receive anything. No API key is entered or stored here: it is OPENAI_API_KEY in the API's server/.env. */
export const SettingsForm: React.FC<{ onChanged: () => void }> = ({ onChanged }) => {
    const [settings, setSettings] = useState<AiSettings | undefined>(undefined);
    const [status, setStatus] = useState<AiStatus | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [allowed, setAllowed] = useState("");
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<string | undefined>(undefined);
    const [models, setModels] = useState<OpenAiModel[] | undefined>(undefined);
    const [loadingModels, setLoadingModels] = useState(false);
    const [modelsError, setModelsError] = useState<string | undefined>(undefined);

    const apply = useCallback((next: AiSettings, nextStatus: AiStatus) => {
        setSettings(next);
        setStatus(nextStatus);
        setAllowed(next.allowedModels.join("\n"));
    }, []);

    useEffect(() => {
        fetchAiSettings()
            .then((result) => apply(result.settings, result.status))
            .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, [apply]);

    if (error) return <p className="text-xs text-destructive break-words">{error}</p>;
    if (!settings || !status) return <div role="status" aria-busy="true" className="space-y-2"><span className="sr-only">Loading settings</span><Skeleton className="h-16 w-full" /><Skeleton className="h-40 w-full" /></div>;

    const update = (patch: Partial<AiSettings>) => setSettings({ ...settings, ...patch });

    const save = async () => {
        setSaving(true);
        try {
            const result = await saveAiSettings({ model: settings.model.trim(), timeoutMs: settings.timeoutMs, allowedModels: lines(allowed), redactNames: settings.redactNames });
            apply(result.settings, result.status);
            setTestResult(undefined);
            toast.success("AI settings saved");
            onChanged();
        } catch (caught) {
            toast.error(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setSaving(false);
        }
    };

    const test = async () => {
        setTesting(true);
        try {
            const result = await testAiSettings();
            setTestResult(result.ok ? `Works: ${result.model} on ${result.endpointHost} answered in ${(result.latencyMs ?? 0) / 1000}s.` : `Failed: ${result.error}`);
        } catch (caught) {
            setTestResult(`Failed: ${caught instanceof Error ? caught.message : String(caught)}`);
        } finally {
            setTesting(false);
        }
    };

    const loadModels = async () => {
        setLoadingModels(true);
        setModelsError(undefined);
        try {
            const result = await fetchOpenAiModels();
            setModels(result.models);
            if (result.error) setModelsError(result.error);
            else if (result.models.length === 0) setModelsError("OpenAI lists no text models for this key.");
        } catch (caught) {
            setModelsError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setLoadingModels(false);
        }
    };

    const modelSource = status.modelFrom === "env" ? ", model from server/.env" : status.modelFrom === "default" ? ", the default" : "";
    return (
        <div className="space-y-4">
            <div className="rounded-lg border bg-card p-3 text-xs">
                <p className="font-medium">Now: {status.model} (OpenAI{modelSource}, {status.endpointHost || "no valid address"})</p>
                <p className={cn("mt-1 break-words", status.configured ? "text-muted-foreground" : "text-destructive")}>
                    {status.configured ? `Ready to use. Credentials: ${status.credentialsSource}.` : status.problem}
                </p>
            </div>

            <section className="space-y-3">
                <h3 className="text-xs font-semibold">OpenAI</h3>
                <p className="max-w-3xl text-[11px] text-muted-foreground">
                    Requests go to the OpenAI API and nowhere else. There is no key to enter here: the API uses <code>OPENAI_API_KEY</code> from its <code>server/.env</code>, and the key never reaches the browser.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Time limit (seconds)" htmlFor="ai-timeout">
                        <Input id="ai-timeout" type="number" min={1} max={900} value={Math.round(settings.timeoutMs / 1000)} onChange={(event) => update({ timeoutMs: Math.max(1, Number(event.target.value) || 120) * 1000 })} className="h-8" />
                    </Field>
                </div>
                <Field label="Model" htmlFor="ai-model" hint="An OpenAI model id such as gpt-5.6-luna. Empty: OPENAI_MODEL from server/.env, else gpt-5.6-luna.">
                    <div className="flex flex-wrap gap-2">
                        <Input id="ai-model" value={settings.model} onChange={(event) => update({ model: event.target.value })} placeholder={status.model} autoComplete="off" spellCheck={false} className="h-8 min-w-0 flex-1 basis-64 font-mono text-xs" />
                        <Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={() => void loadModels()} disabled={loadingModels}>
                            {loadingModels ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null} Load models from OpenAI
                        </Button>
                    </div>
                </Field>
                {models && models.length > 0 && (
                    <Field label={`Models this key can use (${models.length})`}>
                        <Select value={models.some((model) => model.id === settings.model) ? settings.model : undefined} onValueChange={(value) => update({ model: value })}>
                            <SelectTrigger size="sm" className="h-8 w-full min-w-0" aria-label="Pick a model"><SelectValue placeholder="Pick a model" /></SelectTrigger>
                            <SelectContent className="max-h-80">
                                {models.map((model) => (
                                    <SelectItem key={model.id} value={model.id} title={model.id}>
                                        {model.id}{model.owner ? <span className="text-muted-foreground"> · {model.owner}</span> : null}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </Field>
                )}
                {modelsError && <p className="break-words text-xs text-destructive">{modelsError}</p>}
            </section>

            <section className="space-y-3">
                <h3 className="text-xs font-semibold">Which models may receive anything</h3>
                <Field label="Allowed models (one per line, empty = any)" htmlFor="ai-allowed" hint="An exact id, or a prefix ending in *, like gpt-5.6-* A model that is not listed is refused before anything is sent.">
                    <Textarea id="ai-allowed" value={allowed} onChange={(event) => setAllowed(event.target.value)} className="min-h-20 font-mono text-xs" />
                </Field>
            </section>

            <section className="space-y-2">
                <h3 className="text-xs font-semibold">Names</h3>
                <label htmlFor="ai-redact-names" className="flex items-start gap-2 text-xs">
                    <Switch id="ai-redact-names" checked={settings.redactNames} onCheckedChange={(value) => update({ redactNames: value })} aria-label="Replace names with placeholders" className="mt-0.5" />
                    <span><strong className="block">Replace schema, table, column, index and constraint names with placeholders before anything is sent</strong>The model plans against t_3, c_17 and so on; the answer is translated back here. Types, sizes and counts are still sent. “What was sent” on a plan shows exactly what left.</span>
                </label>
            </section>

            <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" className="h-8 gap-1.5" onClick={() => void save()} disabled={saving}>
                    {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save settings
                </Button>
                <Button size="sm" variant="outline" className="h-8" onClick={() => void test()} disabled={testing || saving}>
                    {testing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null} Test the connection
                </Button>
                {testResult && <span className={cn("text-xs break-words", testResult.startsWith("Works") ? "text-muted-foreground" : "text-destructive")}>{testResult}</span>}
            </div>
            <p className="text-[11px] text-muted-foreground">The test sends one short message with no schema in it (a few tokens, billed by OpenAI like any other request). These settings apply to every AI feature in this workspace, including the Modernizer. Anyone who can reach this server can change them.</p>
        </div>
    );
};

export const AuditPanel: React.FC = () => {
    const [entries, setEntries] = useState<AuditEntry[] | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [open, setOpen] = useState<AuditEntry | undefined>(undefined);

    const load = useCallback(() => {
        fetchAudit(200)
            .then((result) => setEntries(result.entries))
            .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)));
    }, []);
    useEffect(load, [load]);

    const show = (entry: AuditEntry) => {
        if (!entry.hasPayload) return setOpen(entry);
        fetchAuditEntry(entry.id).then(setOpen).catch(() => setOpen(entry));
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 flex-1 text-xs text-muted-foreground">Every request to a model, every plan produced, every runbook opened in the SQL Editor, and every settings change. The newest 5,000 are kept. Opening a runbook is recorded; what is run there is not.</p>
                <Button asChild size="sm" variant="outline" className="h-8 gap-1.5"><a href={auditExportUrl("csv")} download><Download className="size-3.5" /> CSV</a></Button>
                <Button asChild size="sm" variant="outline" className="h-8 gap-1.5"><a href={auditExportUrl("json")} download><Download className="size-3.5" /> JSON with payloads</a></Button>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            {!entries && !error && <div role="status" aria-busy="true" className="space-y-2"><span className="sr-only">Loading the log</span>{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>}
            {entries && entries.length === 0 && <p className="text-xs text-muted-foreground">Nothing has been logged yet.</p>}
            {entries && entries.length > 0 && (
                <ul className="divide-y rounded-lg border bg-card">
                    {entries.map((entry) => (
                        <li key={entry.id}>
                            <button type="button" onClick={() => show(entry)} className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-xs hover:bg-accent">
                                <span className="w-36 shrink-0 text-muted-foreground">{formatTime(entry.at)}</span>
                                <span className="min-w-0 flex-1 truncate font-medium">{entry.kind === "model-call" ? `${entry.purpose} (request to the model)` : entry.kind === "plan" ? "plan produced" : entry.kind.replace("-", " ")}{entry.connectionName ? ` · ${entry.connectionName}` : ""}</span>
                                <span className="shrink-0 text-muted-foreground">{entry.model ?? ""}</span>
                                {entry.redacted && <Badge variant="outline" className="text-[10px]">redacted</Badge>}
                                <Badge variant="outline" className={cn("text-[10px]", entry.status !== "ok" && "border-destructive text-destructive")}>{entry.status}</Badge>
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            {open && (
                <section className="space-y-2 rounded-lg border bg-card p-3 text-xs">
                    <div className="flex items-center justify-between">
                        <h3 className="font-semibold">Entry {open.id}</h3>
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => setOpen(undefined)}>Close</Button>
                    </div>
                    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
                        {([
                            ["When", formatTime(open.at)], ["What", `${open.kind} / ${open.purpose}`], ["Status", open.status + (open.error ? `: ${open.error}` : "")], ["Model", open.model ? `${open.model} (${open.provider}${open.endpointHost ? `, ${open.endpointHost}` : ""})` : undefined],
                            ["Names redacted", open.model ? (open.redacted ? "yes" : "no") : undefined], ["Sent", open.requestChars !== undefined ? `${formatCount(open.requestChars)} characters (about ${formatCount(open.requestTokensEstimate ?? 0)} tokens, estimated)` : undefined],
                            ["Reported usage", open.usageInputTokens != null ? `${formatCount(open.usageInputTokens)} in, ${formatCount(open.usageOutputTokens ?? 0)} out` : undefined], ["Latency", open.latencyMs !== undefined ? `${(open.latencyMs / 1000).toFixed(1)} s` : undefined],
                            ["SHA-256 of the payload", open.sha256 ?? undefined], ["Follows entry", open.parentId ? String(open.parentId) : undefined],
                        ] as [string, string | undefined][]).filter(([, value]) => value).map(([name, value]) => (
                            <div key={name} className="contents"><dt className="text-muted-foreground">{name}</dt><dd className="break-all">{value}</dd></div>
                        ))}
                    </dl>
                    {open.detail && <pre className="max-h-40 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">{JSON.stringify(open.detail, null, 2)}</pre>}
                    {open.payload && <details><summary className="cursor-pointer font-medium">Exactly what was sent</summary><pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">{open.payload}</pre></details>}
                    {open.response && <details><summary className="cursor-pointer font-medium">What came back</summary><pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted/50 p-2 font-mono text-[11px] whitespace-pre-wrap break-all">{open.response}</pre></details>}
                </section>
            )}
            {entries && <Alert className="px-3 py-2.5"><AlertTitle className="text-xs">What the log never holds</AlertTitle><AlertDescription className="text-xs">API keys, passwords and row data. A payload is the instructions and the definitions that were sent; with redaction on it holds placeholders.</AlertDescription></Alert>}
        </div>
    );
};
