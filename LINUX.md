# Build Linux (AppImage)

Testé sur Manjaro (Arch).

## Prérequis
sudo pacman -S git base-devel fuse2 pnpm
# Node.js 20+ (nvm, fnm...)

## Build
git clone https://github.com/david15tonon/tastecode.git
cd tastecode
git checkout linux-build
pnpm install
pnpm build
cd apps/desktop
pnpm --filter @harness/default-skills sync
node scripts/build-preload.js
pnpm exec electron-builder --linux AppImage -c.extraMetadata.tastecodeEdition=dev

## Lancer
chmod +x ../../release/*.AppImage
../../release/*.AppImage --no-sandbox
