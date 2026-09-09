import { usePrefs } from '../lib/prefs.js';
import { ConnectionIndicator } from '../log/EventLogPanel.js';
import { useEventStream } from '../log/EventStreamProvider.js';
import { DeskView } from '../views/DeskView.js';
import { LogView } from '../views/LogView.js';
import { AgentsView, ApprovalsView } from '../views/PlaceholderViews.js';
import { SettingsView } from '../views/SettingsView.js';
import { HaltBanner, HaltBar } from './HaltControl.js';
import { Inspector } from './Inspector.js';
import { Rail } from './Rail.js';
import { TabBar } from './TabBar.js';
import { TopNav } from './TopNav.js';
import { DESTINATIONS, useRoute, type Destination } from './navigation.js';
import { useViewport, type Viewport } from './viewport.js';

function View({ dest, viewport }: { dest: Destination; viewport: Viewport }) {
  switch (dest) {
    case 'desk':
      return <DeskView viewport={viewport} />;
    case 'agents':
      return <AgentsView />;
    case 'approvals':
      return <ApprovalsView />;
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
  const viewport = useViewport();
  const [dest, navigate] = useRoute();
  const { railExpanded } = usePrefs();
  const { snapshot } = useEventStream();
  const title = DESTINATIONS.find((d) => d.id === dest)?.label ?? 'Desk';

  const hasRail = viewport === 'tablet' || viewport === 'desktop' || viewport === 'wide';
  const railExpandable = viewport === 'desktop' || viewport === 'wide';

  return (
    <div
      className="app-shell"
      data-viewport={viewport}
      data-rail={railExpandable && railExpanded ? 'expanded' : 'collapsed'}
    >
      {hasRail && <Rail current={dest} onNavigate={navigate} expandable={railExpandable} />}
      {viewport === 'fold' && <TopNav current={dest} onNavigate={navigate} />}
      <div className="app-main">
        <header className="app-header">
          <h1 className="app-header__title">{title}</h1>
          {viewport === 'phone' && <ConnectionIndicator state={snapshot.connection} />}
        </header>
        {viewport !== 'phone' && <HaltBanner />}
        <main id="main" className="app-content" tabIndex={-1}>
          <View dest={dest} viewport={viewport} />
        </main>
      </div>
      {viewport === 'wide' && <Inspector />}
      {viewport === 'phone' && <HaltBar />}
      {viewport === 'phone' && <TabBar current={dest} onNavigate={navigate} />}
    </div>
  );
}
