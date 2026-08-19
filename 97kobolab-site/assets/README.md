# Logo assets

`97kobolab-logo.webp` (372 KB) is what the site loads. `97kobolab-logo.png`
(788 KB) is the same artwork in PNG, kept only because some upload forms —
Squarespace's custom-file manager among them — do not always accept WebP.

Both are 1125 x 1125, transparent background.

## How the artwork is built

- transparent field (~69% of the image)
- wireframe mesh in grey, around `#a1a1a1`
- `97 Kobo Lab` wordmark and the two tagline lines knocked out in near-white

It is **dark-background artwork**. The site applies no CSS filter to it:
inverting would sink the mesh into the page and turn the white type black. On a
white page the type is invisible, which is why it looks like an abstract mark
when you preview it against white.

The artwork sits inside its own transparent padding — 6.04% left, 13.16% top,
13.87% bottom. `.logo` cancels that with negative margins so the mark aligns
with the text column. If you replace this file with a differently-cropped
export, re-measure and update those numbers.

## Provenance

Recovered from the image pasted into the chat, so it is a re-encode rather than
the original master. It is clean at 1:1 and fine to ship. If you have the
original file, drop it in over these — the only thing to check is the padding
figures above.

If both files are absent the hero falls back to a typographic lockup, so the
page still renders correctly.
