# Linux test playbook

How to exercise TasteCode on a Linux test device and collect evidence. For ordinary installation,
follow the [Linux steps in the README](../README.md#linux).

Use the assets from the [Linux preview release](https://github.com/Leonxlnx/tastecode/releases/tag/linux-preview-e9ac0a03):
the deb, AppImage, `SHA256SUMS-linux-x64.txt`, and `linux-release-evidence.json`.
The evidence file records the source commit and package provenance. This preview is not yet
approved for the production release line.

## Install

Pick one of two paths. Prefer the deb: it installs a desktop entry and an AppArmor profile.
Neither path needs a GitHub account. Download the package and checksum file from the preview
release before running the commands below.

**deb**:

```bash
sha256sum --check --ignore-missing SHA256SUMS-linux-x64.txt
sudo apt install --reinstall ./TasteCode-0.1.1-linux-amd64.deb
```

Done when: `dpkg -l tastecode` prints `0.1.1` and `dev.tastecode.desktop` appears in the app menu.

If `apt` exits non-zero, check `dpkg-query -W tastecode` before reporting an install failure: `apt` also configures pending unrelated packages, and a stale DKMS module (e.g. a leftover Waydroid/anbox kernel module failing to build) can fail the command after `tastecode` already reached `install ok installed`. In that case the install succeeded; repair the package manager (`sudo dpkg --configure -a`, remove the stale DKMS package) so the next upgrade is clean.

**AppImage** (no install, no root):

```bash
sha256sum --check --ignore-missing SHA256SUMS-linux-x64.txt
chmod +x TasteCode-0.1.1-linux-x86_64.AppImage
./TasteCode-0.1.1-linux-x86_64.AppImage
```

On Ubuntu 23.10+ and derivatives, an AppImage may fail to start on user namespaces. The app shows a dialog with the fix command; the sysctl line is also in `README.md`.

Done when: the window opens.

## Capture logs

The app writes no log file by default. Logs go to stdout, so launch from a terminal to capture them:

```bash
/usr/bin/tastecode 2>&1 | tee /tmp/tastecode-run.log      # deb
./TasteCode-*.AppImage 2>&1 | tee /tmp/tastecode-run.log  # AppImage
```

Healthy startup looks like:

- `[desktop]`-prefixed lines, no `relaunching with --ozone-platform` on a working Wayland session (that line means the ozone fallback fired — report it if you see it while a display is clearly up)
- no `could not persist gpu-fallback flag` errors
- a `127.0.0.1` server port line; verify with `ss -tlnp | grep tastecode` or check `HARNESS_PORT` conflicts surface as a dialog, not a hang

For deeper inspection, enable diagnostics inside the app: **Settings → Diagnostics → enable**, then **Open diagnostics folder**. Files land in `~/.config/TasteCode/diagnostics/text/` and record renderer crashes, main-process crashes, unhandled rejections, and unresponsive-window events.

Chromium remote debugging, if needed: `HARNESS_DEBUG_PORT=9222 /usr/bin/tastecode`, then `http://127.0.0.1:9222`.

## Agent monitor mode

An agent watching alongside a human tester does not need terminal ownership of the app. Two capture paths, pick by how the app was launched:

**App already running from the desktop menu.** Stdout is unreachable — do not restart the user's session to get it. Instead:

1. Turn on diagnostics without touching the UI (takes effect on next launch; the Settings toggle applies live if the user flips it):
   ```bash
   mkdir -p ~/.config/TasteCode/diagnostics/text
   printf true > ~/.config/TasteCode/diagnostics/text/enabled
   ```
2. Watch while the human works:
   ```bash
   tail -f ~/.config/TasteCode/diagnostics/text/errors.log
   find ~/.config/TasteCode/Crashpad -type f -newermt '-10 min'   # native crash dumps
   pgrep -af 'Taste Code'                                       # process tree alive
   ss -tlnp | grep -E 'tastecode|node'                          # server on 127.0.0.1
   sudo dmesg | grep -i DENIED                                  # AppArmor denials
   ```
3. Diagnostics files are sanitized (private keys and API-token shapes are scrubbed) — safe to copy into a report.

**Agent owns the launch.** Run the terminal capture from the previous section and keep `/tmp/tastecode-run.log` open.

Report findings to `/tmp/tastecode-agent-report.md`: one line per checklist item, then log excerpts with timestamps, then the commands you ran.

## Exercise the app

Run through this list in order. Each item has an expected result; record deviations.

1. **Onboarding.** First launch shows onboarding. Complete it with a real provider.
2. **Provider auth.** Configure at least one provider (Claude Code, Codex, or a direct API key). Keychain-backed secrets require Secret Service (`gnome-keyring` or `kwallet`) — if secrets fail to save, check `journalctl --user -u gnome-keyring*` or install a keyring.
3. **Working task.** Run one real task end to end — for the design goal, ask the design agent to produce something and let it finish.
4. **Window controls.** Frameless title bar: minimize/maximize/close hit areas work across the full 34px height; double-click the drag region toggles maximize.
5. **Close behavior.** Closing the window may only minimize to the tray — on Pop!_OS COSMIC a StatusNotifier host is present, so the app keeps running (`linux tray host: present` in the log, `pgrep -af tastecode` shows the tree). Quit is in the tray icon's menu; verify `pgrep` shows nothing after a real Quit.
6. **Settings → Updates.** Deb installs show a manual-update notice that opens the releases page. The updater excludes this non-versioned preview tag; install a newer preview manually from its release page. Check AppImage update behavior against a versioned release separately. A failed check must show an error row with retry, not silence.
7. **Idle + resume.** Leave running 10+ minutes; the app must stay responsive.

## Health checks while testing

```bash
dpkg -l tastecode                          # installed version
aa-status | grep tastecode                 # AppArmor profile enforced (deb)
pgrep -af tastecode                        # process tree
ss -tlnp | grep -E 'tastecode|node'        # server port bound on 127.0.0.1
ls ~/.config/TasteCode/                    # Electron profile: window-state.json, gpu-fallback.json only if fallback fired
ls ~/.local/share/TasteCode/               # app data: tastecode.db (chats, workspaces), usage-history.json
ls ~/.tastecode/                           # server config: providers.json
dmesg | grep -i DENIED                     # AppArmor denials
```

`gpu-fallback.json` in userData means the GPU fallback relaunched the app — normal on broken drivers, worth reporting on healthy hardware.

For a true from-scratch test, remove the package AND the three data locations above; account tokens additionally live in the system Secret Service keyring and survive every filesystem cleanup — sign out inside the app or clear the keyring to test a cold login.

## Environment variables

| Variable                   | Effect                                                         |
| -------------------------- | -------------------------------------------------------------- |
| `HARNESS_PORT`             | Fixed server port; invalid values fail fast with a clear error |
| `HARNESS_DISABLE_GPU=1`    | Disable hardware acceleration                                  |
| `HARNESS_DEBUG_PORT`       | Chromium remote-debugging port                                 |
| `HARNESS_DESKTOP_DATA_DIR` | Redirect userData (isolated test runs)                         |

## Known gaps in this build

Report these as known, not as new bugs:

- The tray icon needs a StatusNotifier host; where none exists, closing the window quits instead — both behaviors are correct.
- Provider-history mirror threads (`external:<provider>:…`) in 0.1.1 may retain old internal Design-mode prompts when no reliable ownership receipt exists. New builds suppress only envelopes carrying the turn's persisted ownership token, so ordinary quoted text remains visible.
- A flaky PTY-cleanup test exists in `terminal.test.ts` under load — unrelated to runtime behavior.

## Report back

Collect and return:

1. `tastecode-run.log` (or note that stdout was clean)
2. `dpkg -l tastecode` output or AppImage filename + `sha256sum`
3. Contents of `~/.config/TasteCode/diagnostics/text/` if enabled
4. Which checklist items passed or failed, one line each
5. Distro, version, session type (`echo $XDG_SESSION_TYPE`), compositor

## Promotion gates

Before the Linux release branch merges to `main` and Linux joins the published release line:

1. **Merge the packaging set atomically** — package metadata, icons, AppArmor profile, deb dependency alternatives, generated electron-builder metadata (`latest-linux.yml`), license/provenance generation, and release scripts move together. A selective merge produces an unpackageable tree.
2. **Clean-checkout build** — build the deb and AppImage from a clean clone, verify SHA-256 against `SHA256SUMS-linux-x64.txt`, check the provenance in `linux-release-evidence.json`, and install the produced deb on a fresh VM, not only on a dev machine.
3. **Playbook passes on both package states** — once on a clean package database and once on a device with pending unrelated `dpkg` work (the stale-DKMS case). `dpkg-query -W tastecode` is the package-specific verdict when `apt` reports a global package-manager failure.
4. **Functional checklist green on every test device** — onboarding, provider auth persisted through Secret Service, one real end-to-end task, window controls, close/tray behavior matching the DE's StatusNotifier support, deb manual-update notice opening the releases page, AppImage update-in-place through the GitHub release provider, and a 10+ minute idle/resume cycle.
5. **Session matrix spot-check** — at least one Wayland and one X11 run; the ozone fallback must not fire on a healthy Wayland session. One AppImage smoke test on a non-Debian distro or the Ubuntu 23.10+ user-namespace path.
6. **Evidence archived per device** — stdout capture, diagnostics files, Crashpad listing, `dmesg` DENIED lines, process liveness, and the bound `127.0.0.1` server port posted to the QA collection issue (#1283).
7. **Known-issue regression** — on the first build with receipt-owned provider-history filtering, run one real Design-mode provider task. After refresh/import, its owned orchestration envelope must be absent while an ordinary user quote of similar text remains visible. Legacy 0.1.1 mirror records without reliable receipts remain visible.
