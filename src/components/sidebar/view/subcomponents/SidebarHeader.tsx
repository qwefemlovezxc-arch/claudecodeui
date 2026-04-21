import { MessageSquarePlus, PanelLeft, RefreshCw, Search, X } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Input } from '../../../../shared/view/ui';
import { cn } from '../../../../lib/utils';

// Upstream's SearchMode toggle (projects / conversations) was removed
// for the claude.ai-inspired layout — a single search field now queries
// both and the hook decides how to match. The union is kept here so
// callers don't break; both values resolve to the same behavior.
type SearchMode = 'projects' | 'conversations';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SearchMode;
  onSearchModeChange: (mode: SearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onCollapseSidebar: () => void;
  t: TFunction;
};

export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onCollapseSidebar,
  t,
}: SidebarHeaderProps) {
  const showSearch = projectsCount > 0 && !isLoading;

  return (
    <div className="flex-shrink-0">
      {/* Header row: wordmark + collapse toggle. No logo square, no
          app-title subtitle — matches claude.ai's single "Claude"
          wordmark on the left. */}
      <div
        className="flex items-center justify-between gap-2 px-4 pb-2 pt-4 md:pt-5"
        style={isPWA && isMobile ? { paddingTop: '20px' } : {}}
      >
        <span className="text-[22px] font-semibold tracking-tight text-foreground">
          Claude
        </span>
        <div className="flex items-center gap-0.5">
          {isRefreshing && (
            <button
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground"
              onClick={onRefresh}
              disabled
              title={t('tooltips.refresh')}
            >
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
            </button>
          )}
          <button
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={onCollapseSidebar}
            title={t('tooltips.hideSidebar')}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Primary action: "New chat" — large, reads as a nav item rather
          than a tiny icon button. */}
      <div className="px-2 pb-1">
        <button
          onClick={onCreateProject}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition hover:bg-accent"
        >
          <MessageSquarePlus className="h-4 w-4" />
          <span>{t('actions.newChat', { defaultValue: 'New chat' })}</span>
        </button>
      </div>

      {/* Search. Kept available even when there are no projects yet so
          the user doesn't see a shifting layout once they create one. */}
      {showSearch && (
        <div className="px-2 pb-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              type="text"
              placeholder={t('search.conversationsPlaceholder', { defaultValue: 'Search chats…' })}
              value={searchFilter}
              onChange={(event) => onSearchFilterChange(event.target.value)}
              className={cn(
                'nav-search-input h-9 rounded-lg border-0 bg-muted/40 pl-9 pr-8 text-sm',
                'transition-colors duration-150 placeholder:text-muted-foreground/50',
                'focus-visible:bg-muted focus-visible:ring-0 focus-visible:ring-offset-0',
              )}
            />
            {searchFilter && (
              <button
                onClick={onClearSearchFilter}
                aria-label={t('tooltips.clearSearch')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-md p-0.5 hover:bg-accent"
              >
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
