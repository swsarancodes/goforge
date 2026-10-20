import { useEffect, useState } from "react";

/** True once `active` has stayed true for `delayMs`, so fast operations don't flash a loading state. */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
    const [flag, setFlag] = useState<boolean>(false);
    useEffect(() => {
        if (!active) {
            setFlag(false);
            return;
        }
        const id = setTimeout(() => setFlag(true), delayMs);
        return () => clearTimeout(id);
    }, [active, delayMs]);
    return flag;
}
