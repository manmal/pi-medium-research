# pi Medium Research extension

Location: `~/.pi/agent/extensions/medium-research/`

## Upstream credit

This fork is based on the original `pi-medium-research` project by Harmeet Randhawa:
- https://github.com/Soorma718/pi-medium-research

## What it adds

### Tools (LLM-callable)
- `medium_find` — find Medium articles
  - **Free-form queries** use `pi-web-access` search
  - **RSS discovery** is also supported via `tag:<tag>`, `author:<user>`, `pub:<publication>`
- `medium_read` — fetch + extract an article via a **mirror** and return **text/markdown**
  - Default format is **text** (fast) unless overridden
- `medium_research` — find + read N articles and return a bundle in `details` (reads concurrently)
- `medium_cache_clear` — clears the on-disk cache

### Commands (interactive)
- `/medium <query>` — interactive search (select article) + loads content into the editor
- `/medium-cache clear` — clear the on-disk cache

**Fast-path commands (bypass the LLM entirely):**
- `/mfind <query>` — find articles and load a numbered list into the editor
- `/mread <url> [text|markdown]` — read a URL and load content into the editor

## Setup

```bash
cd ~/.pi/agent/extensions/medium-research
npm install
```

Reload pi resources:
- In pi TUI: `/reload`

## Search behavior

### Free-form search

Free-form queries like these:
- `swiftui navigation performance`
- `liquid glass site:medium.com`

use the bundled `pi-web-access` search integration.

If free-form search is temporarily unavailable, the extension logs a short warning, tries RSS tag fallback inferred from your query, and then shows RSS syntax guidance if no fallback results are found.

### RSS discovery (always available)

You can always use RSS-backed discovery syntax:
- `tag:technology`
- `author:towardsdatascience`
- `pub:towards-data-science`

## Configuration

### Mirrors (reading)

By default the extension reads via:
- `https://freedium-mirror.cfd/`

You can configure multiple mirrors (comma-separated). The extension will try them in order:

```bash
export PI_MEDIUM_MIRRORS="https://freedium-mirror.cfd/,https://another-mirror.example/"
```

Or a single base:

```bash
export PI_MEDIUM_MIRROR_BASE="https://freedium-mirror.cfd/"
```

### Default output format (speed)

Default is `text` (fast). Override:

```bash
export PI_MEDIUM_DEFAULT_FORMAT="markdown"  # or "text"
```

### Cache TTL

Default TTL is 24 hours:

```bash
export PI_MEDIUM_CACHE_TTL_HOURS="24"
```

Set to `0` (or a non-positive value) to effectively disable TTL checks.

### Research concurrency

`medium_research` reads multiple articles concurrently. Default is 3:

```bash
export PI_MEDIUM_RESEARCH_CONCURRENCY="3"
```

## Notes / limitations
- Search quality depends on the currently available `pi-web-access` backend/provider.
- Mirrors are third-party services; availability can be intermittent.
- Tool output is truncated to **50KB / 2000 lines**. When truncated, the full article is saved to a temp file and the path is included.
- Cache file:
  - `~/.pi/agent/cache/medium-research/cache.json`

## Development

Run unit tests:

```bash
cd ~/.pi/agent/extensions/medium-research
npm test
```

Continuous integration:
- GitHub Actions workflow: `.github/workflows/ci.yml`
- Runs `npm ci` + `npm test` on push to `main` and on pull requests (Node 20 and 22)
