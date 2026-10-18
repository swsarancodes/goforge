import React, { useCallback } from 'react'
import { cn } from '@/lib/utils'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'
import Menu from './layout/menu/menu'
import { Search } from './search'
import { Button } from './ui/button'

//import { ProfileDropdown } from './profile-dropdown'

import { useModal } from '@/providers/modal-provider/modal-provider'
import { Modals } from '@/providers/modal-provider/modal-contxet'
import { useTranslation } from 'react-i18next'
import { ThemeSwitch } from './theme-switch'
import RenameDb from '@/features/database/components/rename-db'
import LanguagesDropdown from './languages-dropdown'
import { useIsMobile } from '@/hooks/use-mobile'
import { Bot, ShieldCheck } from 'lucide-react'

interface HeaderProps extends React.HTMLAttributes<HTMLElement> {
  fixed?: boolean
  ref?: React.Ref<HTMLElement>
}

export const Header = ({
  className,
  fixed,
  children,
  ...props
}: HeaderProps) => {
  const [offset, setOffset] = React.useState(0)

  React.useEffect(() => {
    const onScroll = () => {
      setOffset(document.body.scrollTop || document.documentElement.scrollTop)
    }
    // Add scroll listener to the body
    document.addEventListener('scroll', onScroll, { passive: true })
    // Clean up the event listener on unmount
    return () => document.removeEventListener('scroll', onScroll)
  }, []);

  const { t } = useTranslation();
  const { open } = useModal();

  const isMobile = useIsMobile();
  return (
    <header
      className={cn(
        'bg-background flex-col md:flex items-center gap-3 p-2 sm:gap-4  ',
        fixed && 'header-fixed peer/header fixed z-50 w-[inherit] rounded-md ',
        offset > 10 && fixed ? 'shadow-sm' : 'shadow-none',
        className
      )}
      {...props}
    >
      <div className='grid grid-cols-3 items-center w-full '>
        <div className="justify-self-start flex h-8 gap-3 items-center  ">
          <SidebarTrigger variant='outline' className='scale-125 sm:scale-100' />
          <Separator orientation='vertical' className='h-6' />
          {!isMobile && <Menu />}
        </div>


        <div className=" justify-self-center ">
          <Search className='hidden lg:flex' placeholder={t("navbar.search")} />
          {
            isMobile &&
            <div className='w-full'>
              <RenameDb />
            </div>
          }
        </div>

        <div className="justify-self-end flex gap-2">
          {
            !isMobile &&
            <div className='w-full'>
              <RenameDb />
            </div>
          }
          
          <Button
            variant="outline"
            size="sm"
            onClick={() => open(Modals.SCHEMA_LINTER)}
            className="h-8 gap-1.5 text-xs font-semibold border-border bg-card/60 hover:bg-card text-foreground transition-all shadow-2xs"
            title="Open Schema Quality & Linter Studio"
          >
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            <span className="hidden xl:inline">Linter</span>
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={() => open(Modals.QUERY_MODERNIZER)}
            className="h-8 gap-1.5 text-xs font-semibold border-primary/30 bg-primary/5 hover:bg-primary/10 text-primary transition-all shadow-2xs"
            title="Open Enterprise Query Modernizer (Multi-Agent Swarm)"
          >
            <Bot className="h-4 w-4 text-primary animate-pulse" />
            <span className="hidden xl:inline">Modernizer</span>
            <span className="text-[10px] bg-primary/20 px-1 py-0.5 rounded font-bold uppercase hidden md:inline">
              Swarm
            </span>
          </Button>

          <ThemeSwitch />
          <LanguagesDropdown />

        </div>
      </div>
      {isMobile && <div className='flex justify-center'>
        <Menu />

      </div>
      }
    </header>
  )
}

Header.displayName = 'Header'
