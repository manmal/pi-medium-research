import test from "node:test";
import assert from "node:assert/strict";

import {
	buildMirrorUrls,
	extractFreedium,
	extractSnippetFromRssDescription,
	isCacheFresh,
	mapWithConcurrency,
	normalizeInputUrl,
	parseMirrorBases,
	retryAsync,
} from "../core.ts";

test("test harness runs", () => {
	assert.equal(1, 1);
});

test("parseMirrorBases defaults when env missing", () => {
	const bases = parseMirrorBases(undefined, ["https://freedium-mirror.cfd/"]);
	assert.deepEqual(bases, ["https://freedium-mirror.cfd/"]);
});

test("parseMirrorBases splits, trims, and enforces trailing slash", () => {
	const bases = parseMirrorBases("https://a.example, https://b.example/", []);
	assert.deepEqual(bases, ["https://a.example/", "https://b.example/"]);
});

test("normalizeInputUrl unwraps mirror URLs", () => {
	const original = normalizeInputUrl(
		"https://freedium-mirror.cfd/https://medium.com/@x/some-article",
		["https://freedium-mirror.cfd/"]
	);
	assert.equal(original, "https://medium.com/@x/some-article");
});

test("normalizeInputUrl keeps non-mirror URLs", () => {
	const original = normalizeInputUrl("https://medium.com/@x/some-article", ["https://freedium-mirror.cfd/"]);
	assert.equal(original, "https://medium.com/@x/some-article");
});

test("buildMirrorUrls prefixes each mirror base", () => {
	const urls = buildMirrorUrls("https://medium.com/@x/some-article", [
		"https://a.example",
		"https://b.example/",
	]);
	assert.deepEqual(urls, [
		"https://a.example/https://medium.com/@x/some-article",
		"https://b.example/https://medium.com/@x/some-article",
	]);
});

test("retryAsync retries and eventually succeeds", async () => {
	let attempts = 0;
	const result = await retryAsync(
		async () => {
			attempts++;
			if (attempts < 3) throw new Error("transient");
			return "ok";
		},
		{
			retries: 3,
			sleep: async () => {},
		}
	);
	assert.equal(result, "ok");
	assert.equal(attempts, 3);
});

test("retryAsync throws after retries exhausted", async () => {
	let attempts = 0;
	await assert.rejects(
		() =>
			retryAsync(
				async () => {
					attempts++;
					throw new Error("transient");
				},
				{ retries: 2, sleep: async () => {} }
			),
		/transient/
	);
	assert.equal(attempts, 2);
});

test("retryAsync does not retry when shouldRetry=false", async () => {
	let attempts = 0;
	await assert.rejects(
		() =>
			retryAsync(
				async () => {
					attempts++;
					throw new Error("permanent");
				},
				{ retries: 5, sleep: async () => {}, shouldRetry: () => false } as any
			),
		/permanent/
	);
	assert.equal(attempts, 1);
});

test("isCacheFresh returns true when within TTL", () => {
	const now = Date.parse("2026-03-01T12:00:00.000Z");
	const fetchedAt = "2026-03-01T11:00:00.000Z";
	assert.equal(isCacheFresh(fetchedAt, 24 * 60 * 60 * 1000, now), true);
});

test("isCacheFresh returns false when outside TTL", () => {
	const now = Date.parse("2026-03-01T12:00:00.000Z");
	const fetchedAt = "2026-02-28T10:59:59.000Z"; // > 49h old
	assert.equal(isCacheFresh(fetchedAt, 24 * 60 * 60 * 1000, now), false);
});

test("extractFreedium(text) preserves code indentation in fenced block", () => {
	const html = `
		<html><body>
			<div class="main-content">
				<h1>Hello</h1>
				<p>Intro</p>
				<pre><code>line1\n  indented\n\t\tmore</code></pre>
				<p>After</p>
			</div>
		</body></html>
	`;
	const out = extractFreedium(html, "text");
	assert.equal(out.title, "Hello");
	assert.match(out.text, /```[\s\S]*line1[\s\S]*  indented[\s\S]*```/);
});

test("extractFreedium extracts author from meta tag when present", () => {
	const html = `
		<html><head><meta name="author" content="Jane Doe" /></head><body>
			<div class="main-content"><h1>T</h1><p>x</p></div>
		</body></html>
	`;
	const out = extractFreedium(html, "text");
	assert.equal(out.author, "Jane Doe");
});

test("extractSnippetFromRssDescription falls back to plain text", () => {
	const desc = `<p>First paragraph.</p><p>Second paragraph.</p>`;
	assert.equal(extractSnippetFromRssDescription(desc), "First paragraph.");
});

test("mapWithConcurrency preserves order and respects concurrency", async () => {
	let active = 0;
	let maxActive = 0;
	const items = [1, 2, 3, 4, 5];
	const out = await mapWithConcurrency(items, 2, async (n) => {
		active++;
		maxActive = Math.max(maxActive, active);
		// simulate async work
		await new Promise((r) => setTimeout(r, 10));
		active--;
		return n * 2;
	});
	assert.deepEqual(out, [2, 4, 6, 8, 10]);
	assert.equal(maxActive <= 2, true);
});
