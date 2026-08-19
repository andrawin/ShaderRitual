Put the logo here as `97kobolab-logo.png`.

The original artwork — grey wireframe on a white background — works as-is. The
site inverts it in CSS, and the page background is pure black (`--bg: #000`) so
the inverted white field lands exactly on the page colour and disappears. The
logo then reads as floating linework rather than a black square.

If you export a version with a **transparent** background instead, that also
works and removes the pure-black constraint, so you'd be free to change `--bg`.

If this file is absent the hero falls back to the typographic lockup, so the
page still renders correctly.
