/** Turns a project name into something safe to use as a file name. */
export const toSafeFileName = (name: string | undefined, fallback = "goforge") => {
    const cleaned = (name ?? "")
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return cleaned || fallback;
};

export const downloadBlob = (blob: Blob, fileName: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Revoke on the next tick so the browser has started the download.
    setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const downloadTextFile = (content: string, fileName: string, mimeType = "text/plain") => {
    downloadBlob(new Blob([content], { type: `${mimeType};charset=utf-8` }), fileName);
};

export const downloadDataUrl = (dataUrl: string, fileName: string) => {
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
};

export const readTextFile = (file: File): Promise<string> => {
    if (typeof file.text === "function") return file.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("Could not read file"));
        reader.readAsText(file);
    });
};

/** Import files are text; reject anything that is obviously huge or binary. */
export const MAX_IMPORT_FILE_BYTES = 5 * 1024 * 1024;
