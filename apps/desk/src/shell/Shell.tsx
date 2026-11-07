import { useCallback, useEffect, useState } from 'react';
import { AgentsView } from '../agents/AgentsView.js';
import { ApprovalsProvider, useApprovals } from '../approvals/ApprovalsProvider.js';
import { ApprovalsView } from '../approvals/ApprovalsView.js';
import { usePrefs } from '../lib/prefs.js';
import { ConnectionIndicator } from '../log/EventLogPanel.js';
import { useEventStream } from '../log/EventStreamProvider.js';
import { RunFocus } from '../runs/RunFocus.js';
import { LimitsProvider } from '../system/limits.js';
import { DeskView } from '../views/DeskView.js';
import { LogView } from '../views/LogView.js';
import { SettingsView } from '../views/SettingsView.js';
import { CommandPalette } from './CommandPalette.js';
import { HaltBanner, HaltBar } from './HaltControl.js';
import { Inspector } from './Inspector.js';
import { Rail } from './Rail.js';
import { TabBar } from './TabBar.js';
import { TopNav } from './TopNav.js';
import { DESTINATIONS, useRoute, type Destination } from './navigation.js';
import { RouteProvider, useRouteApi } from './routeContext.js';
import { useViewport, type Viewport } from './viewport.js';

function View({ dest, viewport }: { dest: Destination; viewport: Viewport }) {
  switch (dest) {
    case 'desk':
      return <DeskView viewport={viewport} />;
    case 'agents':
      return <AgentsView viewport={viewport} />;
    case 'approvals':
      return <ApprovalsView viewport={viewport} />;
    case 'log':
      return <LogView viewport={viewport} />;
    case 'settings':
      return <SettingsView viewport={viewport} />;
  }
}

/**
 * CLAUDE.md §5. Desktop: icon rail + panel grid. Wide: plus the inspector. Tablet: icon-only
 * rail, list-detail views. Fold: single column under a top nav. Phone: the grid is deleted —
 * header, content, sticky halt bar, five-tab bar, safe-area insets from the theme.
 */
export function Shell() {
  const route = useRoute();
  return (
    <RouteProvider value={route}>
      <LimitsProvider>
        <ApprovalsProvider>
          <ShellLayout />
        </ApprovalsProvider>
      </LimitsProvider>
    </RouteProvider>
  );
}

function ShellLayout() {
  const viewport = useViewport();
  const { dest, navigate } = useRouteApi();
  const { railExpanded } = usePrefs();
  const { snapshot } = useEventStream();
  const { pending } = useApprovals();
  const [palette, setPalette] = useState(false);
  const title = DESTINATIONS.find((d) => d.id === dest)?.label ?? 'Desk';

  const hasRail = viewport === 'tablet' || viewport === 'desktop' || viewport === 'wide';
  const railExpandable = viewport === 'desktop' || viewport === 'wide';
  const keyboard = viewport !== 'phone';
  const badges = { approvals: pending.length };

  const closePalette = useCallback(() => {
    setPalette(false);
  }, []);

  useEffect(() => {
    if (!keyboard) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [keyboard]);

  return (
    <div
      className="app-shell"
      data-viewport={viewport}
      data-rail={railExpandable && railExpanded ? 'expanded' : 'collapsed'}
    >
      {hasRail && (
        <Rail current={dest} onNavigate={navigate} expandable={railExpandable} badges={badges} />
      )}
      {viewport === 'fold' && <TopNav current={dest} onNavigate={navigate} />}
      <div className="app-main">
        <header className="app-header">
          <h1 className="app-header__title">{title}</h1>
          {viewport === 'phone' ? (
            <ConnectionIndicator state={snapshot.connection} />
          ) : (
            <button
              type="button"
              className="btn btn--sm palette-trigger"
              onClick={() => {
                setPalette(true);
              }}
              aria-keyshortcuts="Meta+K Control+K"
            >
              Search <kbd className="kbd">⌘K</kbd>
            </button>
          )}
        </header>
        {viewport !== 'phone' && <HaltBanner />}
        <main id="main" className="app-content" tabIndex={-1}>
          <View dest={dest} viewport={viewport} />
        </main>
      </div>
      {viewport === 'wide' && <Inspector />}
      {viewport === 'phone' && <HaltBar />}
      {viewport === 'phone' && <TabBar current={dest} onNavigate={navigate} badges={badges} />}
      <RunFocus viewport={viewport} />
      {palette && keyboard && <CommandPalette onClose={closePalette} />}
    </div>
  );
}
