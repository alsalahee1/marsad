import { z } from 'zod';

// The desk ships under a `script-src 'self'` policy with no 'unsafe-eval'. Zod 4 would otherwise
// probe `new Function` once to pick its compiled fast path; the browser reports that probe as a
// CSP violation even though zod catches it. Jitless skips the probe. Imported first in main.tsx.
z.config({ jitless: true });
