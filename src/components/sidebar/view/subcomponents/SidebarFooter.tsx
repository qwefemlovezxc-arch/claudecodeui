import { ArrowUpCircle, ChevronDown } from 'lucide-react';
import type { TFunction } from 'i18next';
import type { ReleaseInfo } from '../../../../types/sharedTypes';

// Upstream shipped Discord / Report-an-issue / CloudCLI-branding links
// in this footer. This fork is a private Claude-themed deploy so those
// are gone; what remains is:
//   1. Optional "update available" banner (useful when we bump the
//      image tag, still wired to onShowVersionModal).
//   2. A user pill at the bottom — avatar + username + plan label —
//      which opens Settings/account menu when clicked.
// Actual user identity is plumbed in a follow-up; for now the pill
// shows a stubbed "work" profile so the layout lands. Auth wiring
// happens in UI-2.5.

type SidebarFooterProps = {
  updateAvailable: boolean;
  releaseInfo: ReleaseInfo | null;
  latestVersion: string | null;
  currentVersion: string;
  onShowVersionModal: () => void;
  onShowSettings: () => void;
  t: TFunction;
};

export default function SidebarFooter({
  updateAvailable,
  releaseInfo,
  latestVersion,
  onShowVersionModal,
  onShowSettings,
  t,
}: SidebarFooterProps) {
  return (
    <div className="flex-shrink-0" style={{ paddingBottom: 'env(safe-area-inset-bottom, 0)' }}>
      {/* Update banner */}
      {updateAvailable && (
        <div className="px-2 pt-1.5">
          <button
            className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-accent"
            onClick={onShowVersionModal}
          >
            <div className="relative flex-shrink-0">
              <ArrowUpCircle className="h-4 w-4 text-primary" />
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-primary">
                {releaseInfo?.title || `v${latestVersion}`}
              </span>
              <span className="text-[10px] text-primary/70">
                {t('version.updateAvailable', { defaultValue: 'Update available' })}
              </span>
            </div>
          </button>
        </div>
      )}

      {/* User / account pill — opens Settings on click. Placeholder
          identity until UI-2.5 wires the real JWT subject. */}
      <div className="px-2 py-2">
        <button
          onClick={onShowSettings}
          className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-accent"
        >
          <div className="relative flex-shrink-0">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-semibold text-white"
              style={{ background: 'hsl(220 60% 55%)' }}
            >
              W
            </div>
            <div
              className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 bg-sky-500"
              style={{ borderColor: 'hsl(var(--background))' }}
            />
          </div>
          <div className="min-w-0 flex-1 leading-tight">
            <div className="truncate text-sm font-medium text-foreground">work</div>
            <div className="text-[11px] text-muted-foreground">
              {t('account.maxPlan', { defaultValue: 'Max plan' })}
            </div>
          </div>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      </div>
    </div>
  );
}
