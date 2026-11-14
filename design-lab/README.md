# TasteCode Design Lab

A standalone web copy of the TasteCode UI for redesign work. It is not wired to
any server: every screen runs on mock data in `src/data.ts`. When a design is
settled here, it gets ported back into `tastecode-latest/apps/web`.

## Run it

```bash
npm run dev
```

Opens on http://127.0.0.1:5480. The pill in the title bar is lab-only: it
switches between the **New chat** and **Chat** screens, the font, and
light/dark. `?chat=focus-ring` opens the chat screen directly.

## Layout

| Lab file                       | Real app counterpart (`apps/web/src/…`)                         |
| ------------------------------ | --------------------------------------------------------------- |
| `src/styles/tokens.css`        | `styles/tokens.css` (copied as-is: colors, type, radii, motion) |
| `src/styles/lab.css`           | `styles/app.css`, `inbox-sidebar.css`, `thread.css`, …          |
| `src/App.tsx`                  | `App.tsx` (`.shell`, `.stage`), `ui/TitleBar.tsx`, `ui/StageHeader.tsx` |
| `src/components/Sidebar.tsx`   | `ui/Sidebar.tsx`, `styles/account-card.css`                     |
| `src/components/Composer.tsx`  | `ui/Composer.tsx`, `styles/composer-provider-shelf.css`, `context-usage.css` |
| `src/components/Thread.tsx`    | `ui/Thread.tsx`, `styles/thread.css`, `styles/markdown.css`     |

Class names match the app where it has them (`.rail`, `.sessrow`, `.stagehead`,
`.composer`, `.said`, `.reply`), so a change here points at the rule to change there.

## Converting back

1. Port token changes first: diff `src/styles/tokens.css` against the app's copy.
2. Then port component rules screen by screen, checking each in the app's own
   design sandbox (`pnpm sandbox` in `apps/web`, http://127.0.0.1:5420).

`reference/` holds screenshots of the current app (dev `8d2ba1ab`) for comparison.
