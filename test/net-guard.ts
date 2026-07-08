/**
 * Global test net-kill — AGENTS.md rule 4 / DESIGN.md "No-cloud guard".
 *
 * Installs an undici MockAgent as the global dispatcher with disableNetConnect(),
 * so Node's global `fetch` (which reads the same `Symbol.for('undici.globalDispatcher.1')`
 * as the npm `undici` package) cannot reach the network. Any request to a host with no
 * registered intercept throws a MockNotMatchedError — above all `*.okrapdf.com`.
 *
 * Transport tests add explicit intercepts for their fake provider hosts, either by
 * importing `mockAgent` from here or via `getGlobalDispatcher() as MockAgent`.
 *
 * Vitest runs setupFiles per test file (default isolate: true), so each file gets a
 * fresh MockAgent — intercepts never leak across files.
 */

import { MockAgent, setGlobalDispatcher } from 'undici';

export const mockAgent = new MockAgent();
mockAgent.disableNetConnect();
setGlobalDispatcher(mockAgent);
