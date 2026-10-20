import {
    IconTableAlias,
    IconVectorSpline,
    IconSparkles,
    IconDatabase,
    IconTransform,
    IconTerminal2,
} from '@tabler/icons-react'

import type { SidebarData } from '../../types';
import { useTranslation } from 'react-i18next';
import { useMemo } from 'react';

export const useSidebarData = () => {

    const { t } = useTranslation();

    const sidebarData: SidebarData = useMemo(() => ({
        navGroups: [
            {
                title: t("sidebar.database"),
                items: [
                    {
                        title: t("sidebar.tables"),
                        url: '/database/tables',
                        icon: IconTableAlias,
                    },
                    {
                        title: t("sidebar.relationships"),
                        url: '/database/relationships',
                        icon: IconVectorSpline,
                    },
                    {
                        title: t("sidebar.ai_schema", { defaultValue: "AI Schema" }),
                        url: '/database/ai-schema',
                        icon: IconSparkles,
                    },
                    {
                        title: t("sidebar.data", { defaultValue: "Data" }),
                        url: '/database/data',
                        icon: IconDatabase,
                    },
                    {
                        title: t("sidebar.modernizer", { defaultValue: "Modernizer" }),
                        url: '/database/modernizer',
                        icon: IconTransform,
                    },
                    {
                        title: t("sidebar.sql_editor", { defaultValue: "SQL Editor" }),
                        url: '/database/sql',
                        icon: IconTerminal2,
                    },

                ],
            },
            
        ],
        footerNavGroups: []
    }), [t])

    return sidebarData;
}
