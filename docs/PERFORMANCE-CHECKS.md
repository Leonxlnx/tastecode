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

To verify trusted preview height limits, capture cancellation, and storage cleanup using
real Electron windows and the real preload bridge:

```text
node apps/desktop/scripts/verify-preview.js
```

Reports go to `apps/desktop/performance-results/` and `apps/desktop/preview-results/` by
default. Both folders are ignored by Git.

## Pull-request image previews

Targeted regressions cover authenticated uploads, binary output limits, image formats,
relative paths, SVG isolation, visibility-gated loading, request deduplication, and byte-bounded
caches:

```text
pnpm --filter @harness/server exec vitest run src/pull-request-images.test.ts src/pull-requests-gh.test.ts
pnpm --filter @harness/web exec vitest run src/ui/pull-requests/PullRequestImages.test.tsx src/ui/pull-requests/pull-request-image-source.test.ts
```

On 2026-09-15, the running development renderer on macOS loaded real private PNG and JPEG
uploads that returned 404 anonymously. Authenticated cold reads took 920–932 ms; repeated
server-cache reads took 0.08–0.24 ms. A five-image browser remount completed in 11 ms with
zero additional image requests. These are spot measurements, not a network-latency guarantee.

The same browser check loaded a repository-relative SVG, decoded two distinct GIF animation
frames, and confirmed that an SVG could neither execute a script nor request an external
resource. Unit tests exercise 20 queued images with at most four concurrent CLI reads and
30 cached images across ten repeat views without additional RPC calls. The
[format verification screenshot](./verification/pr-image-formats-2026-09-15.png) excludes
private upload contents. This renderer check does not replace the native Electron gate above.
