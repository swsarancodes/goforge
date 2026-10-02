import { getNodesBounds, type Node } from "@xyflow/react";

export type DiagramImageFormat = "png" | "svg";

export interface ExportImageOptions {
    format: DiagramImageFormat;
    /** Leave the background out so the image can be dropped onto any page. */
    transparent: boolean;
    /** Requested PNG pixel ratio (1x, 2x, 3x). Ignored for SVG. */
    scale: number;
}

export const EXPORT_IMAGE_PADDING = 48;

// Browsers silently produce blank canvases past ~16k px on a side or very large areas.
const MAX_CANVAS_SIDE = 16000;
const MAX_CANVAS_AREA = 100_000_000;

/**
 * Lowers the requested pixel ratio until the canvas fits within what browsers can
 * actually allocate. Returns 0 when even a 1x canvas is too big, in which case the
 * caller should ask the user for an SVG instead.
 */
export const resolvePixelRatio = (width: number, height: number, requested: number): number => {
    let ratio = Math.max(1, requested);
    while (ratio >= 1) {
        const side = Math.max(width, height) * ratio;
        const area = width * height * ratio * ratio;
        if (side <= MAX_CANVAS_SIDE && area <= MAX_CANVAS_AREA) return ratio;
        ratio -= 1;
    }
    return 0;
};

export const getExportDimensions = (bounds: { width: number; height: number }) => ({
    width: Math.ceil(bounds.width + EXPORT_IMAGE_PADDING * 2),
    height: Math.ceil(bounds.height + EXPORT_IMAGE_PADDING * 2),
});

const resolveBackgroundColor = () => {
    const computed = getComputedStyle(document.body).backgroundColor;
    const isTransparent = !computed || computed === "transparent" || /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(computed);
    if (!isTransparent) return computed;
    return document.documentElement.classList.contains("dark") ? "#0d1117" : "#ffffff";
};

/**
 * Renders the whole diagram (not just the visible viewport) to an image data URL.
 * Re-positions the xyflow viewport layer for the capture only, so the on-screen
 * canvas is never touched.
 */
export const renderDiagramImage = async (nodes: Node[], options: ExportImageOptions): Promise<string> => {
    if (nodes.length === 0) throw new Error("The diagram is empty, so there is nothing to export.");

    const viewport = document.querySelector<HTMLElement>(".react-flow__viewport");
    if (!viewport) throw new Error("The diagram is not ready yet. Try again in a moment.");

    const bounds = getNodesBounds(nodes);
    const { width, height } = getExportDimensions(bounds);

    // Lazy-loaded: only users who export an image pay for the library.
    const { toPng, toSvg } = await import("html-to-image");

    const backgroundColor = options.transparent ? undefined : resolveBackgroundColor();

    const common = {
        width,
        height,
        backgroundColor,
        style: {
            width: `${width}px`,
            height: `${height}px`,
            transform: `translate(${EXPORT_IMAGE_PADDING - bounds.x}px, ${EXPORT_IMAGE_PADDING - bounds.y}px) scale(1)`,
        },
    };

    // An SVG that embeds every web-font file balloons to megabytes and still renders with
    // the viewer's fonts in most tools, so it keeps font names only. PNGs rasterize the
    // fonts into pixels, so they keep the embedded copies for an exact match.
    if (options.format === "svg") return toSvg(viewport, { ...common, skipFonts: true });

    const pixelRatio = resolvePixelRatio(width, height, options.scale);
    if (pixelRatio === 0) throw new Error("This diagram is too large for a PNG. Export it as SVG instead.");
    return toPng(viewport, { ...common, pixelRatio });
};
