import { Overlay } from '../lib/Overlay.js';
import { useFocus } from '../shell/routeContext.js';
import type { Viewport } from '../shell/viewport.js';
import { RunDetail } from './RunDetail.js';

/**
 * The run that is open, on top of whatever screen is showing. Phone and fold: a full-screen
 * sheet. Tablet and desktop: a dialog. Wide: nothing here, the inspector shows it.
 */
export function RunFocus({ viewport }: { viewport: Viewport }) {
  const { focus, closeRun } = useFocus();
  if (focus.run === null || viewport === 'wide') return null;
  const sheet = viewport === 'phone' || viewport === 'fold';
  return (
    <Overlay mode={sheet ? 'sheet' : 'dialog'} title="Run" onClose={closeRun}>
      <RunDetail runId={focus.run} />
    </Overlay>
  );
}
