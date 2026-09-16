# Local Electron performance checks

Run from the repository root after installing dependencies and building the app:

```text
pnpm build
node apps/desktop/scripts/verify-performance.js 3
```

The gate uses three independent renderer samples and three cold app starts. It opens
isolated test windows, chooses unused loopback ports, and uses temporary data folders.
It does not restart the shared development stack or run hosted CI. A custom report folder
can be passed as the last argument.

The visible fixture renders the real thread component at 1180 by 820 pixels, visits all
500 messages, applies at least 1,000 streamed deltas, and switches among five task stores.
The gate checks the first paint, frame times, delta batch work, session switches, cold
startup, and idle memory against [the architecture budgets](./ARCHITECTURE.md).

Idle memory includes all processes returned by Electron's app metrics. On macOS, the
measurement uses the OS physical footprint for every process and retains summed RSS too.
Other platforms use working-set bytes. A missing footprint falls back to the larger
working-set accounting for that process; missing or zero data fails the gate.

GPU resources can retire several seconds after the final paint. Idle measurement waits
for four samples at least one second apart with the same process identities and at most
2% variation across the whole window. Every sample in that window must be below
500,000,000 bytes. The wait ends after ten seconds and fails if memory does not settle.
The report retains every sample and the transient peak. It does not force garbage
collection, unload the page, purge caches, or change GPU flags.

Keep the machine otherwise quiet during measurement. A failure is a failed check; inspect
the full report before drawing a conclusion. Run this on each release OS. Unit tests
cover the accounting and thresholds; they do not replace real Electron measurements.

For adversarial measurement — 2,000 messages, eight sessions, 240 stream batches, and a
cold start seeded with 1,000 threads across 50 projects — set
`HARNESS_PERF_ADVERSARIAL=1`. Adversarial runs keep every structural coverage check but
relax the budget ceilings; they exist to produce source-bound measurements (the report
records the exact commit), not to pass or fail the gate.

To verify trusted preview height limits, capture cancellation, and storage cleanup using
real Electron windows and the real preload bridge:

```text
node apps/desktop/scripts/verify-preview.js
```

Reports go to `apps/desktop/performance-results/` and `apps/desktop/preview-results/` by
default. Both folders are ignored by Git.
