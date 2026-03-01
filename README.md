# pi Medium Research extension

Location: `~/.pi/agent/extensions/medium-research/`

## What it adds

### Tools (LLM-callable)
- `medium_find` — find Medium articles
  - **Best**: set `EXA_API_KEY` to enable high-quality search via Exa
  - **Fallback (no API key required)**: RSS discovery via `tag:<tag>`, `author:<user>`, `pub:<publication>`
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

## Configuration

### Exa search (recommended)

```bash
export EXA_API_KEY="..."
```

Then you can do free-form queries like:
- `swiftui navigation performance`
- `liquid glass site:medium.com`

Without `EXA_API_KEY`, you must use RSS-backed discovery:
- `tag:technology`
- `author:towardsdatascience`
- `pub:towards-data-science`

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
