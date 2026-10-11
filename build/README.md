# build/

The app icons live here, and they are **generated, not hand-drawn**:

```bash
node scripts/make-icons.mjs     # writes icon.png, icon.ico, icon.icns
```

The script draws the tile procedurally (a rounded, gradient `#5865f2 → #8b5cf6`
square with a bold white `H`), encodes the PNGs itself with `zlib` and no image
library, wraps them in the ICO and icns containers by hand, and then re-reads all
three files to check the magic bytes, the declared sizes and every entry offset
before exiting 0. Re-running it is idempotent, so it is safe in a build step and
safe to commit the output.

Do not edit the binaries by hand - change the geometry in
[make-icons.mjs](../scripts/make-icons.mjs) and re-run it.

| File | Size | Used by |
| --- | --- | --- |
| `icon.png` | 512x512 RGBA | Linux (`build.linux.icon`), and the tray/window icon at runtime |
| `icon.ico` | 256/128/64/48/32/16 | Windows (`build.win.icon`), NSIS installer and portable exe |
| `icon.icns` | 32/64/128/256/512 | macOS (`build.mac.icon`), dmg and zip |

`src/main.js` creates a tray only if `build/icon.png` exists, so deleting these
files makes the client run window-only rather than fail.
