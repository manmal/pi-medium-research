import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type TruncationResult,
} from "@mariozechner/pi-coding-agent";
import { StringEnum, Type } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { XMLParser } from "fast-xml-parser";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { search as webSearch } from "pi-web-access/gemini-search.ts";

import {
	buildMirrorUrls,
	extractFreedium,
	extractSnippetFromRssDescription,
	isCacheFresh,
	mapWithConcurrency,
	normalizeInputUrl,
	normalizeWebSearchResults,
	parseMirrorBases,
	parseRssQuery,
	retryAsync,
	runWebSearchWithRssTagFallback,
	isWebSearchErrorRetryable,
	type MediumReadFormat,
} from "./core.ts";

const DEFAULT_MIRROR_BASES = ["https://freedium-mirror.cfd/"];
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_CACHE_TTL_HOURS = 24;

const USER_AGENT = "pi-medium-research/0.2";

type MediumFindSource = "auto" | "web" | "rss_tag" | "rss_author" | "rss_publication";

interface ArticleRef {
	source: MediumFindSource;
	title: string;
	url: string;
	author?: string;
	publishedAt?: string;
	tags?: string[];
	snippet?: string;
}

interface ArticleContent {
	url: string;
	mirrorUrl: string;
	format: MediumReadFormat;
	title?: string;
	author?: string;
	publishedAt?: string;
	content: string;
	truncation?: TruncationResult;
	fullTextPath?: string;
	fetchedAt: string;
}

interface CacheFile {
	version: 2;
	articles: Record<string, ArticleContent>;
}

function cacheDir(): string {
	return join(homedir(), ".pi", "agent", "cache", "medium-research");
}

function cachePath(): string {
	return join(cacheDir(), "cache.json");
}

function loadCache(): CacheFile {
	try {
		const p = cachePath();
		if (!existsSync(p)) return { version: 2, articles: {} };
		const raw = readFileSync(p, "utf-8");
		const parsed = JSON.parse(raw) as CacheFile;
		if (parsed?.version !== 2 || !parsed.articles) {
			return { version: 2, articles: {} };
		}
		return parsed;
	} catch {
		return { version: 2, articles: {} };
	}
}

function saveCache(cache: CacheFile) {
	mkdirSync(cacheDir(), { recursive: true });
	writeFileSync(cachePath(), JSON.stringify(cache, null, 2));
}

function clearCache(): boolean {
	try {
		if (existsSync(cachePath())) rmSync(cachePath());
		return true;
	} catch {
		return false;
	}
}

function mirrorBases(): string[] {
	const env =
		process.env.PI_MEDIUM_MIRRORS ??
		process.env.PI_MEDIUM_MIRROR_BASE ??
		process.env.MEDIUM_MIRRORS ??
		process.env.MEDIUM_MIRROR_BASE;
	return parseMirrorBases(env, DEFAULT_MIRROR_BASES);
}

function cacheTtlMs(): number {
	const raw = process.env.PI_MEDIUM_CACHE_TTL_HOURS;
	const hours = raw ? Number(raw) : DEFAULT_CACHE_TTL_HOURS;
	if (!Number.isFinite(hours) || hours <= 0) return 0;
	return hours * 60 * 60 * 1000;
}

function researchConcurrency(): number {
	const raw = process.env.PI_MEDIUM_RESEARCH_CONCURRENCY;
	const n = raw ? Number(raw) : 3;
	if (!Number.isFinite(n) || n <= 0) return 1;
	return Math.max(1, Math.floor(n));
}

function defaultFormat(): MediumReadFormat {
	const raw = (process.env.PI_MEDIUM_DEFAULT_FORMAT ?? "").toLowerCase().trim();
	return raw === "markdown" || raw === "md" ? "markdown" : "text";
}

type FetchError = Error & { status?: number; retryable?: boolean };

async function fetchTextOnce(url: string, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	try {
		signal?.addEventListener("abort", onAbort);
		let res: Response;
		try {
			res = await fetch(url, {
				method: "GET",
				headers: {
					"user-agent": USER_AGENT,
					accept: "text/html,application/xml,text/xml;q=0.9,*/*;q=0.8",
				},
				signal: controller.signal,
			});
		} catch (e: any) {
			const err: FetchError = new Error(`Network error for ${url}: ${String(e?.message ?? e)}`);
			err.retryable = true;
			throw err;
		}

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			const err: FetchError = new Error(
				`HTTP ${res.status} for ${url}${body ? `\n\n${body.slice(0, 400)}` : ""}`
			);
			err.status = res.status;
			err.retryable = res.status === 429 || res.status >= 500;
			throw err;
		}
		return await res.text();
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function fetchTextWithRetry(url: string, signal?: AbortSignal): Promise<string> {
	return retryAsync(() => fetchTextOnce(url, signal), {
		retries: 3,
		shouldRetry: (e) => Boolean((e as any)?.retryable),
	});
}

function truncateToToolLimits(content: string): { text: string; truncation: TruncationResult } {
	const truncation = truncateHead(content, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	return { text: truncation.content, truncation };
}

function writeFullTextTempFile(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-medium-"));
	const p = join(dir, "article.txt");
	writeFileSync(p, text);
	return p;
}

async function webSearchArticles(
	query: string,
	options: { numResults: number; signal?: AbortSignal }
): Promise<ArticleRef[]> {
	const q = query.includes("site:") ? query : `site:medium.com ${query}`;

	const runSearch = async (): Promise<ArticleRef[]> => {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		const onAbort = () => controller.abort();
		try {
			options.signal?.addEventListener("abort", onAbort);
			const response = await webSearch(q, {
				numResults: options.numResults,
				domainFilter: ["medium.com"],
				signal: controller.signal,
			});

			const normalized = normalizeWebSearchResults(response.results ?? []);
			return normalized.slice(0, options.numResults).map((r) => ({
				source: "web" as const,
				title: r.title,
				url: r.url,
				snippet: r.snippet,
				publishedAt: r.publishedAt,
			}));
		} catch (e: any) {
			const timedOut = controller.signal.aborted && !options.signal?.aborted;
			const err: FetchError = new Error(
				timedOut ? `Web search timed out after ${DEFAULT_TIMEOUT_MS}ms` : String(e?.message ?? e)
			);
			err.retryable = timedOut ? true : isWebSearchErrorRetryable(e);
			throw err;
		} finally {
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
		}
	};

	return await retryAsync(runSearch, {
		retries: 3,
		shouldRetry: (e) => Boolean((e as any)?.retryable),
	});
}

function parseMediumRss(xml: string, source: MediumFindSource): ArticleRef[] {
	const parser = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: "@_",
		processEntities: true,
	});
	const doc = parser.parse(xml) as any;
	const itemsRaw = doc?.rss?.channel?.item;
	const items: any[] = Array.isArray(itemsRaw) ? itemsRaw : itemsRaw ? [itemsRaw] : [];
	return items
		.map((item) => {
			const title = (item?.title as string | undefined) ?? "";
			const link = (item?.link as string | undefined) ?? "";
			const publishedAt = (item?.pubDate as string | undefined) ?? undefined;
			const author = (item?.["dc:creator"] as string | undefined) ?? undefined;
			const catsRaw = item?.category;
			const cats = Array.isArray(catsRaw) ? catsRaw : catsRaw ? [catsRaw] : [];
			const tags = cats.map((c) => String(c)).filter(Boolean);

			let snippet: string | undefined;
			const desc = item?.description as string | undefined;
			if (desc) snippet = extractSnippetFromRssDescription(desc);

			if (!title || !link) return null;
			return {
				source,
				title,
				url: link,
				author,
				publishedAt,
				tags: tags.length ? tags : undefined,
				snippet,
			} satisfies ArticleRef;
		})
		.filter(Boolean) as ArticleRef[];
}

async function findArticles(params: {
	source: MediumFindSource;
	query?: string;
	tag?: string;
	author?: string;
	publication?: string;
	limit: number;
	signal?: AbortSignal;
}): Promise<ArticleRef[]> {
	if (params.source === "web") {
		if (!params.query) throw new Error("query is required for web search");
		return await webSearchArticles(params.query, { numResults: params.limit, signal: params.signal });
	}

	if (params.source === "rss_tag") {
		if (!params.tag) throw new Error("tag is required for rss_tag");
		const xml = await fetchTextWithRetry(
			`https://medium.com/feed/tag/${encodeURIComponent(params.tag)}`,
			params.signal
		);
		return parseMediumRss(xml, "rss_tag").slice(0, params.limit);
	}

	if (params.source === "rss_author") {
		if (!params.author) throw new Error("author is required for rss_author");
		const a = params.author.replace(/^@/, "");
		const xml = await fetchTextWithRetry(
			`https://medium.com/feed/@${encodeURIComponent(a)}`,
			params.signal
		);
		return parseMediumRss(xml, "rss_author").slice(0, params.limit);
	}

	if (params.source === "rss_publication") {
		if (!params.publication) throw new Error("publication is required for rss_publication");
		const p = params.publication.replace(/^\/+/, "");
		const xml = await fetchTextWithRetry(`https://medium.com/feed/${encodeURIComponent(p)}`, params.signal);
		return parseMediumRss(xml, "rss_publication").slice(0, params.limit);
	}

	// auto
	const q = (params.query ?? "").trim();
	const rssQuery = parseRssQuery(q);

	if (rssQuery?.mode === "rss_tag") {
		return await findArticles({ source: "rss_tag", tag: rssQuery.value, limit: params.limit, signal: params.signal });
	}
	if (rssQuery?.mode === "rss_author") {
		return await findArticles({
			source: "rss_author",
			author: rssQuery.value,
			limit: params.limit,
			signal: params.signal,
		});
	}
	if (rssQuery?.mode === "rss_publication") {
		return await findArticles({
			source: "rss_publication",
			publication: rssQuery.value,
			limit: params.limit,
			signal: params.signal,
		});
	}

	const fallbackResults = await runWebSearchWithRssTagFallback<ArticleRef>({
		query: q,
		runWebSearch: async () => await findArticles({ source: "web", query: q, limit: params.limit, signal: params.signal }),
		runRssTagSearch: async (tag) =>
			await findArticles({ source: "rss_tag", tag, limit: params.limit, signal: params.signal }),
		logWarn: (message) => console.warn(message),
	});
	if (fallbackResults.length > 0) return fallbackResults;

	throw new Error(
		"Free-form search is unavailable and RSS tag fallback found no results. Use one of: tag:<tag>, author:<username>, pub:<publication>."
	);
}

async function readArticle(params: {
	url: string;
	format: MediumReadFormat;
	useCache: boolean;
	signal?: AbortSignal;
}): Promise<ArticleContent> {
	const bases = mirrorBases();
	const originalUrl = normalizeInputUrl(params.url, bases);
	const key = `${originalUrl}::${params.format}`;

	const cache = loadCache();
	if (params.useCache) {
		const hit = cache.articles[key];
		const ttlMs = cacheTtlMs();
		if (hit && (ttlMs === 0 || isCacheFresh(hit.fetchedAt, ttlMs))) return hit;
	}

	const mirrorUrls = buildMirrorUrls(originalUrl, bases);
	const errors: string[] = [];

	for (const mirrorUrl of mirrorUrls) {
		try {
			const html = await fetchTextWithRetry(mirrorUrl, params.signal);
			const extracted = extractFreedium(html, params.format);
			const raw =
				params.format === "markdown" ? extracted.markdown ?? extracted.text : extracted.text;

			const { text: truncated, truncation } = truncateToToolLimits(raw);
			let fullTextPath: string | undefined;
			if (truncation.truncated) fullTextPath = writeFullTextTempFile(raw);

			const article: ArticleContent = {
				url: originalUrl,
				mirrorUrl,
				format: params.format,
				title: extracted.title,
				author: extracted.author,
				publishedAt: extracted.publishedAt,
				content: truncated,
				truncation: truncation.truncated ? truncation : undefined,
				fullTextPath,
				fetchedAt: new Date().toISOString(),
			};

			cache.articles[key] = article;
			saveCache(cache);
			return article;
		} catch (e) {
			errors.push(`${mirrorUrl}\n${String((e as any)?.message ?? e)}`);
		}
	}

	throw new Error(
		`Failed to fetch article via configured mirrors.\n\nMirrors tried:\n- ${mirrorUrls.join(
			"\n- "
		)}\n\nErrors:\n\n${errors.join("\n\n---\n\n")}`
	);
}

const MediumFindParams = Type.Object({
	query: Type.Optional(Type.String({ description: "Search query. For RSS mode you can omit and use tag/author/pub instead." })),
	limit: Type.Optional(Type.Integer({ description: "Max results (default: 10)", minimum: 1, maximum: 50 })),
	source: Type.Optional(
		StringEnum(["auto", "web", "rss_tag", "rss_author", "rss_publication"] as const, {
			description: "Search backend (default: auto).",
		})
	),
	tag: Type.Optional(Type.String({ description: "Used for rss_tag" })),
	author: Type.Optional(Type.String({ description: "Used for rss_author (username, with or without @)" })),
	publication: Type.Optional(Type.String({ description: "Used for rss_publication (publication slug)" })),
});

const MediumReadParams = Type.Object({
	url: Type.String({ description: "Medium article URL" }),
	format: Type.Optional(
		StringEnum(["text", "markdown"] as const, { description: "Output format (default: text)" })
	),
	useCache: Type.Optional(Type.Boolean({ description: "Use local cache if available (default: true)" })),
});

const MediumResearchParams = Type.Object({
	query: Type.String({ description: "Search query (supports tag:<tag>, author:<user>, pub:<publication>)" }),
	limit: Type.Optional(Type.Integer({ description: "How many articles to read (default: 3)", minimum: 1, maximum: 10 })),
	format: Type.Optional(StringEnum(["text", "markdown"] as const, { description: "Output format" })),
});

const EmptyParams = Type.Object({});

export default function (pi: ExtensionAPI) {
	// Tool: medium_find
	pi.registerTool({
		name: "medium_find",
		label: "Medium Find",
		description:
			"Find Medium articles. Free-form queries use pi-web-access search. RSS modes are also supported: tag:<tag>, author:<username>, pub:<publication>.",
		parameters: MediumFindParams,
		async execute(_toolCallId, params, signal) {
			const limit = params.limit ?? 10;
			const source = (params.source ?? "auto") as MediumFindSource;

			const results = await findArticles({
				source,
				query: params.query,
				tag: params.tag,
				author: params.author,
				publication: params.publication,
				limit,
				signal,
			});

			const lines = results.slice(0, limit).map((r, i) => {
				const meta = [r.author ? `by ${r.author}` : null, r.publishedAt ? r.publishedAt : null]
					.filter(Boolean)
					.join(" · ");
				const snip = r.snippet ? `\n   ${r.snippet}` : "";
				return `${i + 1}. ${r.title}${meta ? ` (${meta})` : ""}\n   ${r.url}${snip}`;
			});

			return {
				content: [
					{
						type: "text",
						text: lines.length ? lines.join("\n\n") : "No results found",
					},
				],
				details: { results },
			};
		},
	});

	// Tool: medium_read
	pi.registerTool({
		name: "medium_read",
		label: "Medium Read",
		description: `Fetch and extract a Medium article via a configured mirror (default: ${DEFAULT_MIRROR_BASES[0]}). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
		parameters: MediumReadParams,
		async execute(_toolCallId, params, signal) {
			const format = (params.format ?? defaultFormat()) as MediumReadFormat;
			const useCache = params.useCache ?? true;

			const article = await readArticle({ url: params.url, format, useCache, signal });
			let text = article.content;
			if (article.truncation?.truncated && article.fullTextPath) {
				text += `\n\n[Output truncated: showing ${article.truncation.outputLines} of ${article.truncation.totalLines} lines (${formatSize(article.truncation.outputBytes)} of ${formatSize(article.truncation.totalBytes)}). Full text saved to: ${article.fullTextPath}]`;
			}

			return {
				content: [{ type: "text", text }],
				details: article,
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("medium_read "));
			text += theme.fg("accent", args.url);
			if (args.format) text += theme.fg("dim", ` (${args.format})`);
			return new Text(text, 0, 0);
		},
	});

	// Tool: medium_research
	pi.registerTool({
		name: "medium_research",
		label: "Medium Research",
		description:
			"Find and read multiple Medium articles, returning a bundle (metadata + extracted text). Uses the same backends as medium_find.",
		parameters: MediumResearchParams,
		async execute(_toolCallId, params, signal) {
			const limit = params.limit ?? 3;
			const format = (params.format ?? defaultFormat()) as MediumReadFormat;

			const refs = await findArticles({
				source: "auto",
				query: params.query,
				limit,
				signal,
			});

			const refsToRead = refs.slice(0, limit);
			const articles = await mapWithConcurrency(refsToRead, researchConcurrency(), async (ref) => {
				return await readArticle({ url: ref.url, format, useCache: true, signal });
			});

			const summaryLines = articles.map((a, i) => {
				const title = a.title ?? a.url;
				const meta = [a.author ? `by ${a.author}` : null, a.publishedAt ? a.publishedAt : null]
					.filter(Boolean)
					.join(" · ");
				return `${i + 1}. ${title}${meta ? ` (${meta})` : ""}\n   ${a.url}`;
			});

			return {
				content: [
					{
						type: "text",
						text:
							summaryLines.join("\n\n") +
							"\n\nUse details.articles[i].content for extracted content (possibly truncated).",
					},
				],
				details: { query: params.query, refs, articles },
			};
		},
	});

	// Tool: medium_cache_clear
	pi.registerTool({
		name: "medium_cache_clear",
		label: "Medium Cache Clear",
		description: "Clear the local medium-research on-disk cache.",
		parameters: EmptyParams,
		async execute() {
			const ok = clearCache();
			return {
				content: [{ type: "text", text: ok ? "Cache cleared" : "Failed to clear cache" }],
				details: { ok, cachePath: cachePath() },
			};
		},
	});

	// Command: /medium
	pi.registerCommand("medium", {
		description:
			"Interactive Medium search + read. Free-form uses pi-web-access search; RSS syntax also works (tag:/author:/pub:).",
		handler: async (args, ctx) => {
			const query = args?.trim() || (await ctx.ui.input("Medium query", "e.g. tag:technology or embeddings"));
			if (!query) return;

			const refs = await findArticles({ source: "auto", query, limit: 10 });
			if (!refs.length) {
				ctx.ui.notify("No articles found", "warning");
				return;
			}

			const options = refs.map((r, i) => {
				const meta = [r.author ? `@${r.author}` : null, r.publishedAt ? r.publishedAt : null]
					.filter(Boolean)
					.join(" · ");
				const snippet = r.snippet ? ` — ${r.snippet.replace(/\s+/g, " ").slice(0, 100)}` : "";
				const label = `${r.title}${meta ? ` (${meta})` : ""}${snippet}`;
				return `${i + 1}. ${label}`;
			});

			const choice = await ctx.ui.select("Select article", options);
			if (!choice) return;
			const idx = Math.max(0, parseInt(choice.split(".")[0] ?? "", 10) - 1);
			if (!refs[idx]) return;

			const article = await readArticle({ url: refs[idx].url, format: defaultFormat(), useCache: true });
			ctx.ui.setEditorText(article.content);
			ctx.ui.notify("Loaded article into editor", "info");
		},
	});

	// Command: /medium-cache
	pi.registerCommand("medium-cache", {
		description: "Manage the medium-research cache. Usage: /medium-cache clear",
		handler: async (args, ctx) => {
			const cmd = (args ?? "").trim();
			if (cmd !== "clear") {
				ctx.ui.notify("Usage: /medium-cache clear", "info");
				return;
			}
			const ok = clearCache();
			ctx.ui.notify(ok ? "Cache cleared" : "Failed to clear cache", ok ? "info" : "warning");
		},
	});

	// Command: /mread (fast path, bypasses LLM)
	pi.registerCommand("mread", {
		description: "Read a Medium URL quickly via the mirror. Usage: /mread <url> [text|markdown]",
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const url = parts[0] || (await ctx.ui.input("Medium URL", "https://medium.com/..."));
			if (!url) return;
			const fmtToken = (parts[1] ?? "").toLowerCase();
			const format: MediumReadFormat =
				fmtToken === "markdown" || fmtToken === "md" ? "markdown" : fmtToken === "text" ? "text" : defaultFormat();

			ctx.ui.setStatus("medium-research", `Reading (${format})...`);
			try {
				const article = await readArticle({ url, format, useCache: true });
				ctx.ui.setEditorText(article.content);
				ctx.ui.notify("Loaded article into editor", "info");
			} finally {
				ctx.ui.setStatus("medium-research", "");
			}
		},
	});

	// Command: /mfind (fast path, bypasses LLM)
	pi.registerCommand("mfind", {
		description:
			"Find Medium articles quickly. Usage: /mfind <query>. Free-form uses pi-web-access search; RSS syntax also works (tag:/author:/pub:).",
		handler: async (args, ctx) => {
			let query = (args ?? "").trim();
			if (!query) query = (await ctx.ui.input("Medium query", "e.g. tag:technology or embeddings")) ?? "";
			if (!query.trim()) return;

			let limit = 10;
			// Support: /mfind --limit 5 <query>  OR  /mfind -n 5 <query>
			const m = query.match(/^(?:--limit|-n)\s+(\d+)\s+(.*)$/);
			if (m) {
				limit = Math.max(1, Math.min(50, Number(m[1])));
				query = m[2];
			}

			ctx.ui.setStatus("medium-research", "Searching...");
			try {
				const refs = await findArticles({ source: "auto", query, limit });
				if (!refs.length) {
					ctx.ui.notify("No articles found", "warning");
					return;
				}
				const text = refs
					.slice(0, limit)
					.map((r, i) => {
						const meta = [r.author ? `by ${r.author}` : null, r.publishedAt ? r.publishedAt : null]
							.filter(Boolean)
							.join(" · ");
						const snip = r.snippet ? `\n   ${r.snippet}` : "";
						return `${i + 1}. ${r.title}${meta ? ` (${meta})` : ""}\n   ${r.url}${snip}`;
					})
					.join("\n\n");

				ctx.ui.setEditorText(text);
				ctx.ui.notify("Loaded results into editor", "info");
			} finally {
				ctx.ui.setStatus("medium-research", "");
			}
		},
	});
}
