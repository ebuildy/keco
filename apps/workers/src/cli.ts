import { run } from './lib/cli';
import { workerLogger } from './lib/logger';
import { handlers } from './cli/handlers';
import { buildProgram } from './cli/program';

/**
 * `kecoctl` — the entire write side, one CLI (AGENTS.md §8).
 *
 * Six lines on purpose. The tree is `cli/program.ts`, the loading is `cli/handlers.ts`, the
 * error boundary is `lib/cli.ts`. Nothing decided here means nothing untestable here.
 */
// `parseAsync()` resolves to the `Command` instance (useful for chaining), but `run`'s `work`
// parameter is `() => Promise<void>` — the boundary only cares whether parsing threw, never
// what it returned. The `await` inside a block body discards the resolved value instead of
// forwarding it, which is what makes this satisfy `Promise<void>`.
process.exitCode = await run(
  'kecoctl',
  async () => {
    await buildProgram(handlers).parseAsync();
  },
  { log: workerLogger('kecoctl') },
);
