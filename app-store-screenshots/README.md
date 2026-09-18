# App Store screenshots

Drop device screenshots in and run:

    ./make-screenshots.sh ~/Downloads/IMG_*.png

That imports them to `originals/` (renumbered 01..NN in argument order) and
generates every size. Re-run with no arguments to regenerate from `originals/`.

| Folder | Size | Needed? |
|---|---|---|
| `iphone-6.9/` | 1320×2868 | **yes** — the only size an iPhone app must supply; App Store Connect scales it down for every smaller iPhone |
| `iphone-6.5/` | 1284×2778 | optional |
| `ipad-13/` | 2064×2752 | only if the app ships for iPad — `build-ios.cjs` sets `TARGETED_DEVICE_FAMILY "1"` (iPhone only), so Connect won't offer an iPad slot |

## Things that have bitten us

**TestFlight back-link.** Screenshots from a TestFlight build carry a
"◀ TestFlight" return link in the status bar. It's iOS chrome, not the app,
and it tells every viewer the listing art came from a beta. The script paints
it out; `SKIP_TF_MASK=1` disables that. Only OS chrome is touched — nothing
the app drew.

**Other iOS overlays.** Autofill suggestion pills and notification banners sit
*over* app content, so they can't be masked cleanly. Retake the screen.

**Test data.** Placeholder content like `bar@foo.com` or a bio of "asdf" reads
as a debug build in a store listing. Worth populating a card properly before
capturing.

**No alpha.** App Store Connect rejects screenshots with transparency. The
script flattens on the way out.
