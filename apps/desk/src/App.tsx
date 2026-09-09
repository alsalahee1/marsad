import { AuthGate } from './auth/session.js';
import { PrefsProvider } from './lib/prefs.js';
import { EventStreamProvider } from './log/EventStreamProvider.js';
import { Shell } from './shell/Shell.js';
import { SystemProvider } from './system/systemState.js';

/**
 * Provider order is the dependency order: preferences need nothing, the gate needs the API,
 * the stream needs a session, the system flag projects from the stream, the shell reads all.
 */
export function App() {
  return (
    <PrefsProvider>
      <AuthGate>
        <EventStreamProvider>
          <SystemProvider>
            <Shell />
          </SystemProvider>
        </EventStreamProvider>
      </AuthGate>
    </PrefsProvider>
  );
}
