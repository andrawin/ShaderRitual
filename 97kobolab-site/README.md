# 97kobolab.io

One-page site for **97KoboLab** — audiovisual art + tech lab, Jakarta.
Styled as a Vim buffer: line-number gutter, tabline, statusline, `:` command
line, and a slow parallax backdrop.

```
97kobolab-site/
├── index.html                  ← the whole site. single source of truth.
├── build.py                    ← regenerates the Squarespace snippet
├── assets/                     ← logo, WebP + PNG
└── squarespace/code-block.html ← GENERATED. paste this into Squarespace.
```

No build step, no dependencies. `index.html` is self-contained: markup, CSS and
JS in one file, one external request (Google Fonts, JetBrains Mono).

---

## 1. The logo

Already in place at `assets/97kobolab-logo.webp`, with a PNG copy beside it for
upload forms that reject WebP. See `assets/README.md` for how the artwork is
built and why no CSS filter is applied to it.

The logo carries the wordmark *and* both tagline lines, so the `<h1>` and
tagline in the markup are hidden while it loads — they stay in the DOM for
search engines and screen readers, and become visible again if the image is
ever missing. So the hero never looks broken, and never says anything twice.

## 2. Preview locally

```bash
cd 97kobolab-site
python3 -m http.server 8000     # then open http://localhost:8000
```

## 3. Publish on Squarespace

Custom code requires a **Business plan or higher**.

1. Upload the logo: **Design → Custom CSS → Manage Custom Files → Add images**.
   Use `assets/97kobolab-logo.webp`; if the uploader rejects WebP, use the PNG
   beside it. Copy the file URL it gives you.
2. Regenerate the snippet and paste your logo URL into it:
   ```bash
   python3 build.py
   ```
   Open `squarespace/code-block.html`, find `src="assets/97kobolab-logo.webp"`
   and replace it with the Squarespace URL from step 1. The relative path only
   resolves locally, so this step is required.
3. In Squarespace: **Pages → +** → add a **Blank** page, name it `Home`.
4. Edit the page → add a **Code Block** → paste the entire contents of
   `squarespace/code-block.html` → **Apply** → **Save**.
5. **Pages →** hover the page **→ ⚙ → set as homepage**.
6. Point the domain `www.97kobolab.io` at the site under **Settings → Domains**.

The pasted snippet starts with a small CSS block that hides the Squarespace
template header and footer and strips section padding, so the page renders edge
to edge. Delete that block if you'd rather keep the Squarespace nav bar.

> If Squarespace strips the `<script>` from a Code Block on your plan, put the
> snippet in **Page Settings → Advanced → Page Header Code Injection** instead.
> The page still works without JavaScript — you lose the animated gutter,
> statusline, parallax and `:` commands, but all the content is real HTML.

---

## Editing content

Everything lives in `index.html` next to an `EDIT:` comment.

| What | Where |
| --- | --- |
| Programs | `<article class="prog">` blocks in `<section id="programs">` |
| Schedule | `<li>` rows in `<ul class="sched">` |
| Instagram | the `IG = { … }` object at the top of the `<script>` |
| Address, IG handle, WhatsApp | `<dl class="kv">` in `<section id="contact">` |
| Colours, spacing | the `:root` custom properties at the top of `<style>` |

After editing, run `python3 build.py` and re-paste the code block.

**Adding a schedule row:**

```html
<li>
  <span class="date">03.10</span>
  <span class="what">STRAIT//FREQ Vol.2</span>
  <span class="tag">live a/v show series</span>
</li>
```

Add `class="tag off"` instead of `class="tag"` to mark an event offsite, and
`<span class="warn">**</span>` after the title to flag it against the footnotes.

Vertical rhythm is locked to a 24px baseline (`--lh`) so the gutter line numbers
stay aligned with the text. If you change font sizes, keep line-heights as
multiples of that.

---

## Instagram feed

The feed section supports three modes, set in the `IG` object in `index.html`:

```js
var IG = {
  handle:   '97kobo.lab',
  mode:     'fallback',   // 'behold' | 'embed' | 'fallback'
  beholdId: '',
  count:    8
};
```

**`'behold'` — automatic pull (recommended).** Instagram's own API needs a
server and a refreshing access token, which Squarespace can't host. Behold.so
does that part: create a free account, connect the `@97kobo.lab` account, copy
the feed ID it gives you into `beholdId`, and set `mode: 'behold'`. Posts are
then pulled on page load and rendered into the site's own grid — greyscale by
default, full colour on hover, caption on hover, click through to the post. Free
tier covers the most recent posts and refreshes a few times a day. Any other
service returning a public JSON feed works the same way; the response is read as
either a bare array or `{ posts: [...] }`, using `sizes.medium.mediaUrl`,
`thumbnailUrl` or `mediaUrl` per post.

**`'embed'` — third-party widget.** Set `mode: 'embed'` and paste a
LightWidget / SnapWidget / Elfsight embed into the `<div id="ig-embed">` in the
markup. Their styling won't match the rest of the page.

**`'fallback'` — default.** Eight placeholder tiles that link to the profile.
This is also what shows automatically if a `behold` fetch fails, so the section
never renders empty.

Squarespace also ships its own Instagram block — it auto-pulls, but it can't be
placed inside a code block and won't inherit this design. Behold is the closer
match.

---

## Keyboard / commands

Desktop only; the command line is hidden on touch screens.

| Key | Does |
| --- | --- |
| `j` / `k` | scroll down / up |
| `Ctrl-d` / `Ctrl-u` | half page down / up |
| `gg` / `G` | top / bottom |
| `1`–`5` | jump to section |
| `:` | open the command line |
| `/` | search for a section by name |

Commands: `:e programs.md`, `:schedule`, `:feed`, `:contact`, `:ig` (opens
Instagram), `:wa` (opens WhatsApp), `:gg`, `:G`, `:42` (jump to line 42),
`:help`. Anything else answers with a real Vim error message.

Everything respects `prefers-reduced-motion` — the contour canvas, parallax,
typing and reveal animations all switch off for visitors who ask for that.
