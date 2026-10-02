import Modal, { ModalProps } from "@/components/modal";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import useToast from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { useDatabase } from "@/providers/database-provider/database-provider";
import { DiagramImageFormat, renderDiagramImage } from "@/utils/export-image";
import { downloadDataUrl, toSafeFileName } from "@/utils/file";
import { useReactFlow } from "@xyflow/react";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

const SCALES = [1, 2, 3];

const ExportImageModal: React.FC<Omit<ModalProps, "title" | "children">> = ({ isOpen, onOpenChange }) => {
    const { t } = useTranslation();
    const raise = useToast();
    const { database } = useDatabase();
    const { getNodes } = useReactFlow();

    const [format, setFormat] = useState<DiagramImageFormat>("png");
    const [transparent, setTransparent] = useState(false);
    const [scale, setScale] = useState(2);

    const onExport = useCallback(async () => {
        try {
            const dataUrl = await renderDiagramImage(getNodes(), { format, transparent, scale });
            downloadDataUrl(dataUrl, `${toSafeFileName(database?.name)}.${format}`);
            onOpenChange?.(false);
        } catch (error) {
            raise(
                t("modals.export_image.failed", { defaultValue: "Could not export the image" }),
                error instanceof Error ? error.message : String(error),
                "ERROR",
            );
        }
    }, [getNodes, format, transparent, scale, database?.name, onOpenChange, raise, t]);

    return (
        <Modal
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            title={t("modals.export_image.title", { defaultValue: "Export diagram as image" })}
            description={t("modals.export_image.description", { defaultValue: "Saves the whole diagram, not just the part currently on screen." })}
            actionName={t("modals.export_image.export", { defaultValue: "Export" })}
            actionHandler={onExport}
            isDisabled={(database?.tables.length ?? 0) === 0}
            className="md:min-w-[480px] w-full"
        >
            <div className="flex flex-col gap-5">
                <div className="space-y-2">
                    <Label>{t("modals.export_image.format", { defaultValue: "Format" })}</Label>
                    <RadioGroup value={format} onValueChange={(value) => setFormat(value as DiagramImageFormat)} className="flex gap-2">
                        {(["png", "svg"] as const).map((option) => (
                            <Label
                                key={option}
                                htmlFor={`image-format-${option}`}
                                className={cn("h-8 cursor-pointer rounded-md border px-3 flex items-center hover:bg-secondary", format === option && "border-primary bg-primary/20")}
                            >
                                <RadioGroupItem value={option} id={`image-format-${option}`} className="sr-only" />
                                {option.toUpperCase()}
                            </Label>
                        ))}
                    </RadioGroup>
                </div>

                {format === "png" && (
                    <div className="space-y-2">
                        <Label>{t("modals.export_image.scale", { defaultValue: "Resolution" })}</Label>
                        <RadioGroup value={String(scale)} onValueChange={(value) => setScale(Number(value))} className="flex gap-2">
                            {SCALES.map((option) => (
                                <Label
                                    key={option}
                                    htmlFor={`image-scale-${option}`}
                                    className={cn("h-8 cursor-pointer rounded-md border px-3 flex items-center hover:bg-secondary", scale === option && "border-primary bg-primary/20")}
                                >
                                    <RadioGroupItem value={String(option)} id={`image-scale-${option}`} className="sr-only" />
                                    {option}x
                                </Label>
                            ))}
                        </RadioGroup>
                    </div>
                )}

                <div className="flex items-center justify-between gap-4">
                    <Label htmlFor="image-transparent">{t("modals.export_image.transparent", { defaultValue: "Transparent background" })}</Label>
                    <Switch id="image-transparent" checked={transparent} onCheckedChange={setTransparent} />
                </div>
            </div>
        </Modal>
    );
};

export default React.memo(ExportImageModal);
