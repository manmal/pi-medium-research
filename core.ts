import * as cheerio from "cheerio";
import TurndownService from "turndown";

export type MediumReadFormat = "text" | "markdown";

export function ensureTrailingSlash(base: string): string {
	return base.endsWith("/") ? base : `${base}/`;
}

export function parseMirrorBases(envValue: string | undefined, defaults: string[]): string[] {
	const raw = (envValue ?? "").trim();
	if (!raw) return defaults.map(ensureTrailingSlash);

	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map(ensureTrailingSlash);
}

export function normalizeInputUrl(inputUrl: string, mirrorBases: string[]): string {
	const bases = mirrorBases.map(ensureTrailingSlash);
	for (const base of bases) {
		if (inputUrl.startsWith(base)) {
			const rest = inputUrl.slice(base.length);
			// Freedium-style mirror URLs are typically `${base}${originalUrl}`
			if (rest.startsWith("http://") || rest.startsWith("https://")) return rest;
		}
	}
	return inputUrl;
}

export function buildMirrorUrls(originalUrl: string, mirrorBases: string[]): string[] {
	const bases = mirrorBases.map(ensureTrailingSlash);
	return bases.map((b) => `${b}${originalUrl}`);
}

export async function retryAsync<T>(
	fn: () => Promise<T>,
	options: {
		/** Maximum attempts (including the first attempt). */
		retries: number;
		/** Optional sleep injection for tests. */
		sleep?: (ms: number) => Promise<void>;
		/** Optional predicate that decides whether an error is retryable. */
		shouldRetry?: (error: unknown) => boolean;
	}
): Promise<T> {
	const maxAttempts = Math.max(1, options.retries);
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

	let lastError: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (e) {
			lastError = e;
			if (options.shouldRetry && !options.shouldRetry(e)) throw e;
			if (attempt === maxAttempts) throw e;
			// Minimal exponential backoff.
			const delayMs = 250 * Math.pow(2, attempt - 1);
			await sleep(delayMs);
		}
	}
	throw lastError;
}

export function isCacheFresh(fetchedAtIso: string | undefined, ttlMs: number, nowMs = Date.now()): boolean {
	if (!fetchedAtIso) return false;
	const fetchedAt = Date.parse(fetchedAtIso);
	if (Number.isNaN(fetchedAt)) return false;
	return nowMs - fetchedAt <= ttlMs;
}

function normalizeWhitespace(text: string): string {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/[ \t]+/g, " ")
		.replace(/\n\s+\n/g, "\n\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function normalizeOutsideCodeFences(text: string): string {
	const input = text.replace(/\r\n/g, "\n");
	const parts: string[] = [];
	let lastIndex = 0;
	const re = /```[\s\S]*?```/g;
	for (const match of input.matchAll(re)) {
		const idx = match.index ?? 0;
		parts.push(normalizeWhitespace(input.slice(lastIndex, idx)));
		parts.push(match[0]);
		lastIndex = idx + match[0].length;
	}
	parts.push(normalizeWhitespace(input.slice(lastIndex)));
	return parts.filter((p) => p.length > 0).join("\n\n");
}

export function extractSnippetFromRssDescription(descriptionHtml: string): string | undefined {
	try {
		const $ = cheerio.load(descriptionHtml);
		const byClass = $(".medium-feed-snippet").first().text().trim();
		if (byClass) return normalizeWhitespace(byClass);

		const firstP = $("p").first().text().trim();
		if (firstP) return normalizeWhitespace(firstP);

		const all = $.text().trim();
		if (!all) return undefined;
		return normalizeWhitespace(all).slice(0, 240);
	} catch {
		const raw = descriptionHtml.replace(/<[^>]+>/g, " ").trim();
		return raw ? normalizeWhitespace(raw).slice(0, 240) : undefined;
	}
}

export type RssQueryMode = "rss_tag" | "rss_author" | "rss_publication";

export interface ParsedRssQuery {
	mode: RssQueryMode;
	value: string;
}

export function parseRssQuery(query: string): ParsedRssQuery | undefined {
	const q = query.trim();
	if (!q) return undefined;

	const tagMatch = q.match(/(?:^|\s)tag:([\w-]+)/i);
	if (tagMatch?.[1]) return { mode: "rss_tag", value: tagMatch[1] };

	const authorMatch = q.match(/(?:^|\s)author:@?([\w-]+)/i);
	if (authorMatch?.[1]) return { mode: "rss_author", value: authorMatch[1] };

	const pubMatch = q.match(/(?:^|\s)pub:([\w-]+)/i);
	if (pubMatch?.[1]) return { mode: "rss_publication", value: pubMatch[1] };

	return undefined;
}

export function extractRssFallbackTags(query: string, limit = 3): string[] {
	const stopWords = new Set(["site", "medium", "com", "www", "http", "https"]);
	const tokens = (query.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(
		(token) => !stopWords.has(token)
	);

	const deduped: string[] = [];
	for (const token of tokens) {
		if (deduped.includes(token)) continue;
		deduped.push(token);
		if (deduped.length >= Math.max(1, limit)) break;
	}
	return deduped;
}

export function isWebSearchErrorRetryable(error: unknown): boolean {
	const message = String((error as any)?.message ?? error).toLowerCase();
	if (!message) return false;
	if (message.includes("abort")) return false;
	if (message.includes("api key not found")) return false;
	if (message.includes("no search provider available")) return false;
	if (message.includes("gemini search unavailable")) return false;

	return (
		message.includes("timeout") ||
		message.includes("timed out") ||
		message.includes("network") ||
		message.includes("fetch failed") ||
		message.includes("econn") ||
		message.includes("rate limited") ||
		message.includes(" 429") ||
		message.includes(" 500") ||
		message.includes(" 502") ||
		message.includes(" 503") ||
		message.includes("temporar")
	);
}

export async function runWebSearchWithRssTagFallback<T>(params: {
	query: string;
	runWebSearch: () => Promise<T[]>;
	runRssTagSearch: (tag: string) => Promise<T[]>;
	logWarn?: (message: string) => void;
}): Promise<T[]> {
	try {
		return await params.runWebSearch();
	} catch (e) {
		const message = String((e as any)?.message ?? e);
		params.logWarn?.(
			`[medium-research] Web search unavailable; trying RSS tag fallback. ${message.slice(0, 160)}`
		);
	}

	for (const tag of extractRssFallbackTags(params.query)) {
		try {
			const rssResults = await params.runRssTagSearch(tag);
			if (rssResults.length > 0) return rssResults;
		} catch {
			// keep trying next candidate tag
		}
	}

	return [];
}

export interface WebSearchResultCandidate {
	title?: string;
	url?: string;
	snippet?: string;
	text?: string;
	highlights?: string[];
	publishedAt?: string;
	publishedDate?: string;
}

export interface NormalizedWebSearchResult {
	title: string;
	url: string;
	snippet?: string;
	publishedAt?: string;
}

export function normalizeWebSearchResults(results: WebSearchResultCandidate[]): NormalizedWebSearchResult[] {
	return results
		.map((r) => {
			const url = (r.url ?? "").trim();
			if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) return null;

			const title = (r.title ?? "").trim() || url;
			const rawSnippet =
				(r.snippet ?? "").trim() ||
				(r.highlights?.[0] ?? "").trim() ||
				(r.text ?? "").trim();
			const snippet = rawSnippet ? normalizeWhitespace(rawSnippet).slice(0, 400) : undefined;
			const publishedAt = (r.publishedAt ?? r.publishedDate ?? "").trim() || undefined;

			return {
				title,
				url,
				snippet,
				publishedAt,
			} satisfies NormalizedWebSearchResult;
		})
		.filter(Boolean) as NormalizedWebSearchResult[];
}

export async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const limit = Math.max(1, Math.floor(concurrency));
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function worker() {
		while (true) {
			const i = nextIndex++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	}

	await Promise.all(new Array(Math.min(limit, items.length)).fill(0).map(() => worker()));
	return results;
}

export function extractFreedium(
	html: string,
	format: MediumReadFormat
): { title?: string; author?: string; publishedAt?: string; text: string; markdown?: string } {
	const $ = cheerio.load(html);
	const title = $("h1").first().text().trim() || undefined;
	const author = $("meta[name=author]").attr("content")?.trim() || undefined;
	const publishedAt = $("time").first().attr("datetime")?.trim() || undefined;

	const root = $(".main-content").first();
	if (!root.length) {
		throw new Error("Freedium page did not contain .main-content; layout may have changed.");
	}

	// TEXT: preserve code indentation by emitting fenced blocks.
	const textBlocks: string[] = [];
	root.find("p,h1,h2,h3,h4,li,blockquote,pre").each((_i, el) => {
		const tag = (el as any).tagName?.toLowerCase?.() ?? "";
		if (tag === "pre") {
			const raw = $(el).text().replace(/\r\n/g, "\n").replace(/\n+$/g, "");
			if (raw.trim().length) textBlocks.push(`\n\n\`\`\`\n${raw}\n\`\`\`\n\n`);
			return;
		}

		if (tag === "li") {
			const t = $(el).text().trim();
			if (t) textBlocks.push(`- ${t}`);
			return;
		}

		if (tag === "blockquote") {
			const t = $(el).text().trim();
			if (!t) return;
			const quoted = t
				.split(/\r?\n/)
				.map((l) => (l.trim() ? `> ${l.trim()}` : ">"))
				.join("\n");
			textBlocks.push(quoted);
			return;
		}

		const t = $(el).text().trim();
		if (t) textBlocks.push(t);
	});
	const text = normalizeOutsideCodeFences(textBlocks.join("\n\n"));

	if (format === "text") return { title, author, publishedAt, text };

	const turndown = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		emDelimiter: "_",
	});
	const rootHtml = root.html() || "";
	const markdown = normalizeWhitespace(turndown.turndown(rootHtml));
	return { title, author, publishedAt, text, markdown };
}
