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
