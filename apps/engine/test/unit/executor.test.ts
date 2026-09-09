import { approvalSuite, executorSuite } from '../support/suites.js';
import { createMemoryStore } from '../support/memoryStore.js';

executorSuite(async () => createMemoryStore());
approvalSuite(async () => createMemoryStore());
