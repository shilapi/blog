# Design QA

## Scope

- Source references: `/Users/lapi/Downloads/bookmark example.png` and `/Users/lapi/Downloads/og image.png`
- Implementations: `/about/`, article detail pages, and generated `/og/*.png` images
- Browser checks: 1920×1080 wide layout and 1280×720 constrained layout in the Codex in-app browser

## Comparison passes

### Bookmark tile

- Typography and hierarchy match the reference intent: prominent mono title, muted two-line preview, and a favicon/hostname lockup anchored at the lower left.
- The tile reuses the site's existing black-violet surface, pointer-responsive elevation, fixed hitbox, and lower-right corner signature. No additional border was introduced.
- Real X and GitHub metadata rendered on `/about/`; external metadata failure falls back to a stable hostname/path presentation.
- The reference is a standalone full-width sketch, while the implementation respects the existing Notion two-column layout and scales the same hierarchy into that available column.
- Whole-tile link semantics, accessible labels, keyboard focus, and reduced-motion behavior are present.

### Article table of contents

- The collapsed state is a one-to-one vertical series of dots using `--border` for unread entries and `--accent-strong` for headings in the reading path.
- Hover or keyboard focus swaps dots for heading labels in place. Labels use stepped left-to-right clipping; dots cross-fade. Heading 2 entries indent only when a Heading 1 exists.
- Every entry uses the measured width of the widest label as its fixed hitbox. The TOC is fixed in unused right-side space and does not alter article width or margins.
- At 1920×1080 the TOC appears and remains clear of the article. At 1280×720 it hides because the measured hitbox does not fit.
- Click navigation, stable heading anchors, reading progress, current-location semantics, and reduced-motion scrolling were verified.

### Open Graph image

- Generated output uses the standard 1200×630 social-card ratio, the site's exact palette, strong title/muted summary hierarchy, an optional real article thumbnail, a left fade for legibility, and the lower-right corner signature.
- A real Notion featured image was checked for crop quality and contrast. Pages without a thumbnail preserve the same text composition on the dark background.
- Canonical, Open Graph, and Twitter card metadata point to absolute `https://lapiw.icu/og/*.png` URLs.
- All visible text uses the bundled Pretendard font during image generation, including CJK titles.

## Findings

- P0: none.
- P1: none.
- P2: none after fixing the TOC's hidden-first-measurement state and moving the progress threshold to the primary reading area.

## Validation

- `npm exec astro -- check`: passed with 0 errors, warnings, or hints.
- `npm run build`: passed; 32 pages generated, including site, archive, and per-article OG PNG routes.
- Bookmark, TOC collapsed/expanded states, TOC jumps, progress colors, constrained-width hiding, OG dimensions, and social metadata were checked against real Notion content.

final result: passed
