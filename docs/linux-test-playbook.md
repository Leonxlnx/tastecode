# Linux test playbook

How to install Taste Code on a Linux test device, exercise it, and collect evidence.
Written for agents running the test; a human can follow the same steps.

Build under test: `0.1.0-beta.8` (fixed), branch `feat/linux-release-v1-current`, HEAD `d840b6c5`.
Assets live on the `v0.1.0-beta.8` draft release: deb, AppImage, `latest-linux.yml`, `SHA256SUMS-linux-x64.txt`.

## Install

Pick one of two paths. Prefer the deb: it installs a desktop entry, an AppArmor profile, and the Secret Service integration.

**deb** (needs `gh` auth, or download from the release page in a browser):

```bash
gh release download v0.1.0-beta.8 -R Leonxlnx/tastecode -p 'TasteCode-*-linux-amd64.deb' -p 'SHA256SUMS-linux-x64.txt'
sha256sum --check --ignore-missing SHA256SUMS-linux-x64.txt   # must print OK
sudo apt install ./TasteCode-0.1.0-beta.8-linux-amd64.deb
```

Done when: `dpkg -l tastecode` prints `0.1.0~beta.8` and `dev.tastecode.desktop` appears in the app menu.

**AppImage** (no install, no root):

```bash
gh release download v0.1.0-beta.8 -R Leonxlnx/tastecode -p 'TasteCode-*-x86_64.AppImage' -p 'SHA256SUMS-linux-x64.txt'
sha256sum --check --ignore-missing SHA256SUMS-linux-x64.txt
chmod +x TasteCode-0.1.0-beta.8-linux-x86_64.AppImage
./TasteCode-0.1.0-beta.8-linux-x86_64.AppImage
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
5. **Close behavior.** With a StatusNotifier tray host, close keeps the app in tray. Without one (COSMIC), close quits — both are correct.
6. **Settings → Updates.** Deb installs show a manual-update notice; AppImage checks the release provider. A failure must show an error row with retry, not silence.
7. **Idle + resume.** Leave running 10+ minutes; the app must stay responsive.

## Health checks while testing

```bash
dpkg -l tastecode                          # installed version
aa-status | grep tastecode                 # AppArmor profile enforced (deb)
pgrep -af tastecode                        # process tree
ss -tlnp | grep -E 'tastecode|node'        # server port bound on 127.0.0.1
ls ~/.config/TasteCode/                    # userData: window-state.json, gpu-fallback.json only if fallback fired
dmesg | grep -i DENIED                     # AppArmor denials
```

`gpu-fallback.json` in userData means the GPU fallback relaunched the app — normal on broken drivers, worth reporting on healthy hardware.

## Environment variables

| Variable                   | Effect                                                         |
| -------------------------- | -------------------------------------------------------------- |
| `HARNESS_PORT`             | Fixed server port; invalid values fail fast with a clear error |
| `HARNESS_DISABLE_GPU=1`    | Disable hardware acceleration                                  |
| `HARNESS_DEBUG_PORT`       | Chromium remote-debugging port                                 |
| `HARNESS_DESKTOP_DATA_DIR` | Redirect userData (isolated test runs)                         |

## Known gaps in this build

Report these as known, not as new bugs:

- The deb update notice points at `releases/latest`, which currently lacks Linux assets — resolves when the branch merges and a real release ships.
- Tray menu only appears where a StatusNotifier host exists; COSMIC sessions quit on close by design.
- A flaky PTY-cleanup test exists in `terminal.test.ts` under load — unrelated to runtime behavior.

## Report back

Collect and return:

1. `tastecode-run.log` (or note that stdout was clean)
2. `dpkg -l tastecode` output or AppImage filename + `sha256sum`
3. Contents of `~/.config/TasteCode/diagnostics/text/` if enabled
4. Which checklist items passed or failed, one line each
5. Distro, version, session type (`echo $XDG_SESSION_TYPE`), compositor
