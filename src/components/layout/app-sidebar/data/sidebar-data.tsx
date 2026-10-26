import {
    IconTableAlias,
    IconVectorSpline,
    IconGitCompare,
    IconDatabase,
    IconTransform,
    IconTerminal2,
    IconArrowsExchange,
    IconColumns,
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
                        title: t("sidebar.schema_change", { defaultValue: "Schema Change" }),
                        url: '/database/schema-change',
                        icon: IconGitCompare,
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
                        title: t("sidebar.migrate", { defaultValue: "Migrate" }),
                        url: '/database/migrate',
                        icon: IconArrowsExchange,
                    },
                    {
                        title: t("sidebar.query_check", { defaultValue: "Query check" }),
                        url: '/database/query-check',
                        icon: IconColumns,
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
