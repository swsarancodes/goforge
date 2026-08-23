import {
    IconTableAlias,
    IconVectorSpline,
    IconSparkles,
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
           
                ],
            },
            
        ],
        footerNavGroups: []
    }), [t])

    return sidebarData;
}
