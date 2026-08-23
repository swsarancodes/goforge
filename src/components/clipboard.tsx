import React, { useCallback, useEffect, useRef, useState } from "react";

import { useTranslation } from "react-i18next";


import { Copy, CopyCheck } from "lucide-react";
import { Tooltip , TooltipContent, TooltipTrigger} from "./ui/tooltip";


import { Button } from "./ui/button";




interface ClipboardProps {
    text?: string
}

const Clipboard: React.FC<ClipboardProps> = ({ text }) => {
    const { t } = useTranslation();


    const [isCopied, setIsCopied] = useState<boolean>(false);
    const resetTimer = useRef<ReturnType<typeof setTimeout>>();

    useEffect(() => () => {
        if (resetTimer.current) clearTimeout(resetTimer.current);
    }, []);

    const copyToClipboard = useCallback(async () => {


        if (text)
            try {
                if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                } else {
                    const textarea = document.createElement("textarea");
                    textarea.value = text;
                    textarea.style.position = "fixed";
                    textarea.style.opacity = "0";
                    document.body.appendChild(textarea);
                    textarea.select();
                    const copied = document.execCommand("copy");
                    textarea.remove();
                    if (!copied) throw new Error("Clipboard copy is unavailable");
                }
                setIsCopied(true);
                if (resetTimer.current) clearTimeout(resetTimer.current);
                resetTimer.current = setTimeout(() => {
                    setIsCopied(false);
                }, 1200)

            } catch (err) {

                setIsCopied(false);
            }

    }, [text])

    return (
  <Tooltip>
            <TooltipTrigger asChild>
                <span>
                    <Button
                        size="icon"
                        variant="outline"
                        className="w-7 h-7 text-muted-foreground bg-card/50   backdrop-blur-xs dark:backdrop-blur-md shadow-lg"
                        onClick={copyToClipboard}
                        disabled={!text}
                        aria-label={!isCopied ? t("clipboard.copy") : t("clipboard.copied")}
                    >
                        {
                            !isCopied ? <Copy className="size-4" /> : <CopyCheck className="size-4" />

                        }
                    </Button>
                </span>
            </TooltipTrigger>
            <TooltipContent>
                {!isCopied ? t("clipboard.copy") : t("clipboard.copied")}
            </TooltipContent>
        </Tooltip>
    )
};

export default React.memo(Clipboard)
