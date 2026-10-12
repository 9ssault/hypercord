# build/

The app icons live here, and they are **generated, not hand-drawn**:

```bash
node scripts/make-icons.mjs     # writes icon.png, icon.ico, icon.icns
```

## The tile is black

The brand is a black tile with a **white** mark and a hairline rim. Three things
about that are deliberate:

* the mark is white **because the tile is black** - a black mark on a black tile is
  invisible, which is the one mistake to avoid when the branding goes black;
* the rim (`#2a2c34`, 3.6 units at 512) is what keeps the tile legible as a tile on a
  black desktop or a black window, instead of a floating white letter;
* the tile is **not themeable**: it is a logo, so it does not read `--hc-accent`. The
  old tile was an accent gradient, which is why a screenshot of the client showed a
  blue-violet square while the theme claimed to be AMOLED black.

[icon.svg](icon.svg) is the same geometry as reviewable vector - read it to check the
proportions, and change it *and* the generator together when the mark changes.

The generator draws the tile procedurally (black `#000000` fill, the `#2a2c34` rim, a
bold white `H`), encodes the PNGs itself with `zlib` and no image library, wraps them
in the ICO and icns containers by hand, and then re-reads all three files to check the
magic bytes, the declared sizes and every entry offset before exiting 0. Re-running it
is idempotent, so it is safe in a build step and safe to commit the output.

Do not edit the binaries by hand - change the geometry in
[make-icons.mjs](../scripts/make-icons.mjs) (and [icon.svg](icon.svg)) and re-run it.

> A committed binary from an older generator looks perfectly valid in review - the
> file is there, the offsets check out - which is how a blue-violet tile kept
> shipping after the brand had gone black. When the mark changes, the icons have to
> be regenerated in the same commit as the change.

| File | Size | Used by |
| --- | --- | --- |
| `icon.svg` | vector, 512 viewBox | review only; not packaged |
| `icon.png` | 512x512 RGBA | Linux (`build.linux.icon`), and the tray/window icon at runtime |
| `icon.ico` | 256/128/64/48/32/16 | Windows (`build.win.icon`), NSIS installer and portable exe |
| `icon.icns` | 32/64/128/256/512 | macOS (`build.mac.icon`), dmg and zip |

`src/main.js` creates a tray only if `build/icon.png` exists, so deleting these
files makes the client run window-only rather than fail.
