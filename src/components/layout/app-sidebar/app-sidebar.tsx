import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarRail,
} from '@/components/ui/sidebar'


import { NavGroup } from '../nav-group'
import { useSidebarData } from './data/sidebar-data'
import { Separator } from '@/components/ui/separator';
import { useDiagramOps } from '@/providers/diagram-provider/diagram-provider';
import logo from '@/assets/favicon.png';

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
    const sidebarData = useSidebarData();
    const { openController } = useDiagramOps();
    return (
        <Sidebar collapsible='icon'  {...props}  >
            <SidebarHeader>
                <div className='flex items-center gap-2'>
                    <img
                        className='w-8 p-[4px] rounded-md shrink-0'
                        src={logo}
                        alt='GoForge'
                    />
                    <h3 className='truncate font-semibold text-sm group-data-[collapsible=icon]:hidden'>
                        GoForge
                    </h3>
                </div>
            </SidebarHeader>
            <SidebarContent>
                {sidebarData.navGroups.map((props: any, index: number) => (
                    <div key={props.title}>
                        <NavGroup key={props.title} {...props} onClick={() => openController(true)} />
                        {
                            index != sidebarData.navGroups.length - 1 &&
                            <div className='px-2'>
                                <Separator />
                            </div>
                        }
                    </div>
                ))}
            </SidebarContent>
            <SidebarFooter className='p-0'>
                {sidebarData.footerNavGroups.map((props: any, index: number) => (
                    <div key={props.title}>
                        <NavGroup key={props.title} {...props} />
                        {
                            index != sidebarData.navGroups.length - 1 &&
                            <div className='px-2'>
                                <Separator />
                            </div>
                        }
                    </div>
                ))}
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    )
}
