
import { PowerSyncDatabase } from '@powersync/web';
import { PowerSyncContext, usePowerSync } from "@powersync/react";
import { createContext, Suspense, useContext, useEffect, useState } from 'react';
import { AppSchema, drizzleSchema } from '@/lib/schemas/app-schema';
import { GoForgeConnector } from '@/utils/goforge-connector';

import { PowerSyncSQLiteDatabase, wrapPowerSyncWithDrizzle } from '@powersync/drizzle-driver';
import { seedDataTypes } from '@/lib/data_types/seed_datatypes';



export const powerSyncDb = new PowerSyncDatabase({
    database: {
        dbFilename: 'goforge.sqlite',
    },
    schema: AppSchema,
    // GoForge is a local-first editor and does not coordinate writes across tabs.
    // Avoid the SharedWorker path, which can leave wa-sqlite stuck after a dev
    // reload in browsers that aggressively retain the previous worker instance.
    flags: {
        enableMultiTabs: false,
    },
});

export const db: PowerSyncSQLiteDatabase<typeof drizzleSchema> = wrapPowerSyncWithDrizzle(powerSyncDb, {
    schema: drizzleSchema,
});

const ConnectorContext = createContext<GoForgeConnector | null>(null);
export const useConnector = () => useContext(ConnectorContext);

interface SyncProviderProps {
    children: React.ReactNode;
}

export const SyncProvider: React.FC<SyncProviderProps> = ({ children }) => {

    const [powerSync] = useState(powerSyncDb);

    useEffect(() => {
        const seed = async () => {
            await seedDataTypes(db) ; 
        }
        seed();
    }, [db])
    return (
        <Suspense >
            <PowerSyncContext.Provider value={powerSync}>
                {children}
            </PowerSyncContext.Provider>
        </Suspense>
    )
}
