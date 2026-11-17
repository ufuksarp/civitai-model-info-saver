// ==UserScript==
// @name         Civitai Model Info Saver
// @version      1.0.3
// @description  A userscript to download Civitai model info as a ZIP with a presentable HTML page. If the model is later removed by Civitai or the author, you will still have the info.
// @author       ufuksarp
// @namespace    https://github.com/ufuksarp
// @license      GPL-3.0-only
// @match        https://civitai.com/*
// @match        https://civitai.red/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      civitai.com
// @connect      civitai.red
// @require      https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.15.0/dist/zip-core.min.js
// ==/UserScript==

(function () {

"use strict";

// --- Constants (endpoints, bundles, host-page UI) ---
// Civitai browsing-level bitmask for .red merge-on: com-style gallery slice (PG + PG-13).
const COM_BROWSING_LEVEL = 3;

function getScriptVersion() {
	try {
		return String(GM_info?.script?.version || "");
	} catch (_) {
		return "";
	}
}
/** CDN middle segment: Standard still images (800 px optimized JPEG/PNG/WebP; model-carousel 1x). */
const CIVITAI_STANDARD_IMAGE_SEGMENT = "anim=false,width=800,optimized=true";
/** CDN middle segment: Standard gallery videos (800 px transcode, not a JPEG poster). */
const CIVITAI_STANDARD_VIDEO_SEGMENT = "transcode=true,width=800,optimized=true";
const MEDIA_CONCURRENCY = 5;
const META_CONCURRENCY = 5;
const REPLY_CONCURRENCY = 10;
const GALLERY_MAX = 50;

// --- Page URL ---
function isHttpUrl(s) {
	return /^https?:\/\//i.test(String(s || ""));
}

function getModelIdFromUrl() {
	const match = window.location.pathname.match(/^\/models\/(\d+)/);
	return match ? Number(match[1]) : null;
}

async function fetchTrpcVersion(modelId, versionId) {
	if (!modelId || versionId == null) return null;
	const model = await trpc("model.getById", { id: modelId }).catch(() => null);
	return (model?.modelVersions || []).find((v) => v?.id === versionId) || null;
}

// --- HTTP ---
function gmGet(url, opts) {
	return new Promise((resolve, reject) => {
		GM_xmlhttpRequest({
			method: "GET",
			url,
			timeout: 60000,
			...opts,
			onload: resolve,
			onerror: reject,
			ontimeout() {
				reject(new Error("Request timed out"));
			},
		});
	});
}

/** tRPC requires Origin/Referer; GM_xmlhttpRequest sends neither (401 since Civitai May 2026). */
function requestJson(url) {
	if (String(url || "").includes("/api/trpc/")) {
		const pageWin =
			typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
		return pageWin
			.fetch(url, {
				credentials: "include",
				headers: { Accept: "application/json" },
			})
			.then((r) => r.json());
	}
	return gmGet(url, { headers: { Accept: "application/json" } }).then((res) =>
		JSON.parse(res.responseText),
	);
}

/** tRPC result.data: `{ json }` envelope, or packed index-array string. */
function unwrapTrpcData(response) {
	let data = response?.result?.data;
	if (data == null) return null;
	if (typeof data === "object" && !Array.isArray(data) && "json" in data) {
		return data.json;
	}
	if (typeof data === "string") {
		try {
			data = JSON.parse(data);
		} catch (_) {
			return null;
		}
	}
	if (!Array.isArray(data) || !data.length) {
		return typeof data === "object" ? data : null;
	}
	const seen = new Map();
	function hydrate(i) {
		if (i === -1) return null;
		if (seen.has(i)) return seen.get(i);
		const v = data[i];
		if (!v || typeof v !== "object") return v;
		const out = Array.isArray(v) ? [] : {};
		seen.set(i, out);
		if (Array.isArray(v)) {
			for (let j = 0; j < v.length; j++) out[j] = hydrate(v[j]);
		} else {
			for (const k in v) out[k] = hydrate(v[k]);
		}
		return out;
	}
	return hydrate(0);
}

async function trpcQuery(path, input) {
	const url = `${window.location.origin}/api/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`;
	return unwrapTrpcData(await requestJson(url));
}

async function trpc(path, json) {
	return trpcQuery(path, { json });
}

async function runPool(items, size, worker) {
	for (let i = 0; i < items.length; i += size) {
		await Promise.all(items.slice(i, i + size).map(worker));
	}
}

function runDownloadErrorLabel(e) {
	const msg = e && e.message != null ? String(e.message) : String(e || "");
	return /timed out/i.test(msg) ? "timed out" : "failed";
}

function fetchMediaBuffer(url) {
	const okBuf = (b) =>
		b && typeof b.byteLength === "number" && b.byteLength > 0 ? b : null;
	return gmGet(url, { responseType: "arraybuffer" }).then(
		(res) => {
			const st = res.status;
			const buf = okBuf(res.response);
			if (st >= 200 && st < 300 && buf) return { buf, err: null };
			return {
				buf: null,
				err: Number.isFinite(st) && st > 0 ? String(st) : "failed",
			};
		},
		(err) => ({ buf: null, err: runDownloadErrorLabel(err) }),
	);
}

// --- Civitai API (models, images, comments) ---
async function fetchModelFromHost(hostBase, modelId) {
	return requestJson(hostBase + "/api/v1/models/" + modelId);
}

function mergeVersionImagesById(primaryVersions, secondaryVersions) {
	const secondaryMap = new Map(
		(secondaryVersions || []).map((v) => [v?.id, v]),
	);
	return (primaryVersions || []).map((pv) => {
		const sv = secondaryMap.get(pv?.id);
		const pImages = Array.isArray(pv?.images) ? pv.images : [];
		const sImages = Array.isArray(sv?.images) ? sv.images : [];
		const merged = [];
		const seen = new Set();
		pImages.concat(sImages).forEach((img) => {
			const key = String(img?.url || "");
			if (!key || seen.has(key)) return;
			seen.add(key);
			merged.push(img);
		});
		return { ...pv, images: merged };
	});
}

// --- Gallery media (author previews; CDN URLs) ---
function mediaExt(url, mime) {
	const map = {
		"image/jpeg": "jpeg",
		"image/jpg": "jpg",
		"image/png": "png",
		"image/webp": "webp",
		"image/gif": "gif",
		"video/mp4": "mp4",
		"video/webm": "webm",
	};
	const fromMime = map[String(mime || "").toLowerCase()] || null;
	if (fromMime) return fromMime;
	const ext = (String(url || "").split(".").pop() || "")
		.split("?")[0]
		.toLowerCase();
	return /^(png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(ext) ? ext : null;
}

/** CDN URL extensions don't match the served format (e.g. `.jpeg` serving WebP or PNG), so read the file signature. */
function sniffMediaExt(buf) {
	const b = new Uint8Array(buf, 0, Math.min(1024, buf.byteLength));
	const ascii = (start, end) => String.fromCharCode(...b.subarray(start, end));
	if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
	if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
	if (ascii(1, 4) === "PNG") return "png";
	if (ascii(0, 3) === "GIF") return "gif";
	if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
	if (ascii(4, 8) === "ftyp") {
		const brand = ascii(8, 12);
		if (/^avi[fs]/.test(brand)) return "avif";
		return brand === "qt  " ? "mov" : "mp4";
	}
	// Local files get their MIME type from the extension, and SVG only renders as image/svg+xml.
	const head = ascii(0, b.length);
	if (/^(?:\xEF\xBB\xBF)?\s*</.test(head) && /<svg[\s>]/i.test(head)) return "svg";
	return null;
}

function getGalleryMediaKind(item, restItem) {
	const type = String(restItem?.type || item?.type || "").toLowerCase();
	if (type === "video") return "video";
	const mime = String(restItem?.mimeType || item?.mimeType || "").toLowerCase();
	if (mime.startsWith("video/")) return "video";
	const url = String(restItem?.url || item?.url || "");
	if (/\.(mp4|webm|mov)(\?|#|$)/i.test(url)) return "video";
	return "image";
}

function buildVersionImageLookup(images) {
	const byUuid = new Map();
	const byRecordId = new Map();
	(images || []).forEach((img) => {
		const uuid = getImageUuid(img);
		const rid = getCivitaiImageRecordId(img);
		if (uuid) byUuid.set(uuid, img);
		if (rid != null) byRecordId.set(rid, img);
	});
	return { byUuid, byRecordId };
}

function extractStoragePrefix(url) {
	if (!url) return null;
	const m = String(url).match(/^https?:\/\/image\.civitai\.com\/([^\/]+)\//i);
	return m ? m[1] : null;
}

function getStoragePrefixFromVersions(versions) {
	const list = Array.isArray(versions) ? versions : [];
	for (const version of list) {
		const imgs = Array.isArray(version?.images) ? version.images : [];
		for (const img of imgs) {
			const p = extractStoragePrefix(img?.url);
			if (p) return p;
		}
	}
	return null;
}

function getImageUuid(item) {
	const url = String(item?.url || "");
	const m = url.match(/^https?:\/\/image\.civitai\.com\/[^\/]+\/([a-f0-9-]+)\//i);
	return m ? m[1].toLowerCase() : url.toLowerCase();
}

/** Numeric Civitai image id for API calls (nested shapes + CDN URL filename). */
function getCivitaiImageRecordId(item) {
	if (!item || typeof item !== "object") return null;
	const pick = (v) => {
		if (v == null || v === "") return null;
		const n = Number(v);
		return Number.isFinite(n) && n > 0 ? n : null;
	};
	let id =
		pick(item.id) ??
		pick(item.imageId) ??
		pick(item.image?.id) ??
		pick(item.media?.id);
	if (id != null) return id;
	const url = String(item.url || item.image?.url || "");
	if (!url) return null;
	const m =
		url.match(/\/original=true\/(\d+)\.[a-z0-9]+/i) ||
		url.match(/\/original=true\/(\d+)(?:\?|\/|$)/i);
	return m ? Number(m[1]) : null;
}

function resolveGalleryMediaUrl(item, prefix) {
	const raw = String(item?.url || "");
	if (isHttpUrl(raw)) return raw;
	if (!prefix || !raw) return null;
	const kind = getGalleryMediaKind(item);
	const ext =
		mediaExt("", item?.mimeType) || (kind === "video" ? "mp4" : "jpeg");
	const rid = getCivitaiImageRecordId(item);
	const filename = rid != null ? String(rid) : raw;
	return `https://image.civitai.com/${prefix}/${raw}/original=true/${filename}.${ext}`;
}

function mergeAndResolveGalleryMedia(prefix, lists, restLookup) {
	const merged = [];
	const seen = new Set();
	(lists || []).forEach((list) => {
		if (!Array.isArray(list)) return;
		list.forEach((item) => {
			const uuid = getImageUuid(item);
			if (!uuid || seen.has(uuid)) return;
			const resolvedUrl = resolveGalleryMediaUrl(item, prefix);
			if (!resolvedUrl) return;
			const enrichedItem = { ...item, url: resolvedUrl };
			let rest = null;
			if (restLookup) {
				const restUuid = getImageUuid(enrichedItem);
				if (restUuid && restLookup.byUuid.has(restUuid))
					rest = restLookup.byUuid.get(restUuid);
				else {
					const rid = getCivitaiImageRecordId(enrichedItem);
					rest = rid != null ? restLookup.byRecordId.get(rid) || null : null;
				}
			}
			const kind = getGalleryMediaKind(enrichedItem, rest);
			const url = rest?.url && isHttpUrl(rest.url) ? rest.url : resolvedUrl;
			seen.add(uuid);
			merged.push({ ...enrichedItem, url, kind });
		});
	});
	return merged;
}

function resolveExportMediaUrl(url, kind, useStandardMedia) {
	const raw = String(url || "");
	if (!raw || !useStandardMedia) return raw;
	const segment =
		kind === "video"
			? CIVITAI_STANDARD_VIDEO_SEGMENT
			: CIVITAI_STANDARD_IMAGE_SEGMENT;
	const extReplaceRe = kind === "video" ? /\.(mp4|mov)(\?|#|$)/i : null;
	try {
		const h = new URL(raw).hostname.toLowerCase();
		if (h !== "civitai.com" && !h.endsWith(".civitai.com")) return raw;
	} catch (_) {
		return raw;
	}
	const u = raw.trim();
	if (u.includes(segment)) return u;
	if (u.includes("/original=true/")) {
		let out = u.replace("/original=true/", "/" + segment + "/");
		// Site player requests transcodes as .webm
		if (extReplaceRe) out = out.replace(extReplaceRe, ".webm$2");
		return out;
	}
	return u.replace(
		/\/original\/?(\?[^#]*)?(#.*)?$/i,
		"/" + segment + "$1$2",
	);
}

function readBoolPref(key, defaultVal) {
	try {
		const v = localStorage.getItem(key);
		if (v === "0" || v === "1") return v === "1";
	} catch (_) {
		/* ignore */
	}
	return defaultVal;
}

function writeBoolPref(key, val) {
	try {
		localStorage.setItem(key, val ? "1" : "0");
	} catch (_) {
		/* ignore */
	}
}

function isCivitaiRedHost() {
	return window.location.hostname === "civitai.red";
}

async function fetchVersionGalleryImages(
	modelVersionId,
	prioritizedUserId,
	browsingLevel,
) {
	const all = [];
	let cursor = null;
	const seen = new Set();
	while (true) {
		const input = {
			json: {
				modelVersionId,
				prioritizedUserIds: prioritizedUserId ? [prioritizedUserId] : [],
				period: "AllTime",
				sort: "Most Reactions",
				limit: 20,
				pending: true,
				include: [],
				withMeta: false,
				excludedTagIds: [],
				disablePoi: true,
				disableMinor: false,
				cursor,
				authed: true,
				...(browsingLevel != null ? { browsingLevel } : {}),
			},
			...(cursor == null
				? { meta: { values: { cursor: ["undefined"] } } }
				: {}),
		};
		const json = await trpcQuery("image.getInfinite", input);
		const items = Array.isArray(json?.items) ? json.items : [];
		all.push(...items);
		if (all.length >= GALLERY_MAX) return all.slice(0, GALLERY_MAX);
		const next = json?.nextCursor;
		if (!items.length || next == null || seen.has(String(next))) break;
		seen.add(String(next));
		cursor = next;
	}
	return all;
}

async function buildImageMetas(mergedImages) {
	if (!Array.isArray(mergedImages) || !mergedImages.length) return [];
	const results = new Array(mergedImages.length).fill(null);
	await runPool(
		mergedImages
			.map((img, idx) => ({ idx, id: getCivitaiImageRecordId(img) }))
			.filter((item) => item.id != null),
		META_CONCURRENCY,
		async (item) => {
			const meta = await trpc("image.getGenerationData", {
				id: item.id,
				authed: true,
			}).catch(() => null);
			results[item.idx] = meta || null;
		},
	);
	return results;
}

async function paginate(load, pick) {
	const all = [];
	let cursor;
	const seen = new Set();
	while (true) {
		const { page, next } = pick(await load(cursor));
		if (page.length) all.push(...page);
		if (!page.length || next == null || seen.has(next)) return all;
		seen.add(next);
		cursor = next;
	}
}

function commentRoots(json) {
	if (!json || !Array.isArray(json.comments))
		throw new Error("Could not load comments");
	const byId = new Map(json.comments.map((c) => [c?.id, c]));
	const page = (
		Array.isArray(json.rootIds)
			? json.rootIds.map((id) => byId.get(id))
			: json.comments.filter((c) => c && c.parentId == null)
	).filter(Boolean);
	return { page, next: json.nextCursor };
}

async function fetchCommentPages(modelId, hidden, onProgress, startCount) {
	let shown = startCount;
	return paginate(
		(cursor) =>
			trpc("commentv3.getSection", {
				entityType: "model",
				entityId: modelId,
				sort: "Newest",
				...(hidden ? { hidden: true } : {}),
				...(cursor ? { cursor } : {}),
			}),
		(json) => {
			const picked = commentRoots(json);
			shown += picked.page.length;
			onProgress?.("Fetching comments " + shown + "…");
			return picked;
		},
	);
}

async function fetchComments(modelId, onProgress) {
	onProgress?.("Fetching comments 0…");
	const visible = await fetchCommentPages(modelId, false, onProgress, 0);
	const hidden = await fetchCommentPages(modelId, true, onProgress, visible.length);
	const seen = new Set();
	return visible.concat(hidden).filter((c) => {
		const id = c?.id;
		if (id == null) return true;
		if (seen.has(id)) return false;
		seen.add(id);
		return true;
	});
}

async function fetchReplyTree(parentId) {
	const flat = [];
	const seen = new Set();
	async function walk(id) {
		const replies = await paginate(
			(cursor) =>
				trpc("commentv3.getReplies", {
					parentId: id,
					sort: "Oldest",
					...(cursor ? { cursor } : {}),
				}),
			(json) => ({
				page: Array.isArray(json?.comments) ? json.comments : [],
				next: json?.children?.[id]?.nextCursor ?? json?.nextCursor,
			}),
		);
		for (const reply of replies) {
			if (!reply || seen.has(reply.id)) continue;
			seen.add(reply.id);
			flat.push(reply);
			if (reply.replyCount > 0) await walk(reply.id);
		}
	}
	await walk(parentId);
	return flat;
}

async function fetchReplies(comments, onProgress) {
	if (!comments?.length) return comments;
	const queue = [];
	comments.forEach((c, idx) => {
		if (c?.replyCount > 0 && c.id != null) queue.push({ idx, id: c.id });
	});
	if (!queue.length) return comments;
	let done = 0;
	onProgress?.("Fetching comment replies 0/" + queue.length + "…");
	await runPool(queue, REPLY_CONCURRENCY, async (item) => {
		comments[item.idx]._replies = await fetchReplyTree(item.id).catch(() => []);
		onProgress?.(
			"Fetching comment replies " + ++done + "/" + queue.length + "…",
		);
	});
	return comments;
}

// --- Payload shaping (comments row model) ---
function mapCommentRow(c, includeAnswers) {
	const row = {
		commenterName: c?.user?.username || "",
		commentDate: c?.createdAt || "",
		reactions: c?.reactions || {},
		content: c?.content || "",
		hidden: !!c?.hidden,
	};
	if (includeAnswers) {
		row.answers = c?.replyCount ?? null;
		row.answerComments = Array.isArray(c?._replies)
			? c._replies.map((reply) => mapCommentRow(reply, false))
			: [];
	}
	return row;
}

// --- Single-model snapshot for export bundle ---
async function getModelData(onProgress) {
	const modelId = getModelIdFromUrl();
	if (!modelId) throw new Error("Could not parse model ID from URL");

	const mergeDomains =
		isCivitaiRedHost() && !readBoolPref("cmis_pref_this_site", false);
	const pageOrigin = window.location.origin;

	onProgress?.("Fetching model data…");
	let model;
	let modelRed = null;
	if (mergeDomains) {
		const [modelCom, modelRedMerged] = await Promise.all([
			fetchModelFromHost("https://civitai.com", modelId).catch(() => null),
			fetchModelFromHost("https://civitai.red", modelId).catch(() => null),
		]);
		modelRed = modelRedMerged;
		model = modelCom || modelRed;
	} else {
		model = await fetchModelFromHost(pageOrigin, modelId).catch(() => null);
		if (isCivitaiRedHost()) modelRed = model;
	}
	if (!model)
		throw new Error(
			"Could not load model data from civitai.com or civitai.red",
		);

	const baseVersions = Array.isArray(model?.modelVersions)
		? model.modelVersions
		: [];
	const redVersions = Array.isArray(modelRed?.modelVersions)
		? modelRed.modelVersions
		: [];
	// Union .com and .red version records for export metadata (also merges REST gallery images per version).
	const versions = mergeDomains
		? mergeVersionImagesById(baseVersions, redVersions)
		: baseVersions;
	const v = new URLSearchParams(window.location.search).get("modelVersionId");
	const n = v != null ? Number(v) : NaN;
	const urlVersionId = Number.isFinite(n) ? n : null;
	const currentVersion =
		(urlVersionId != null
			? versions.find((v) => v?.id === urlVersionId)
			: null) ||
		versions[0] ||
		{};
	const currentVersionId = currentVersion?.id;
	const authorUserId =
		model?.creator?.id ||
		model?.userId ||
		model?.user?.id ||
		modelRed?.creator?.id ||
		modelRed?.userId ||
		modelRed?.user?.id ||
		null;
	onProgress?.("Fetching gallery list…");
	const trpcGalleryImages = currentVersionId
		? await fetchVersionGalleryImages(currentVersionId, authorUserId)
		: [];
	const imageLists = [trpcGalleryImages];
	if (mergeDomains && currentVersionId)
		imageLists.push(
			await fetchVersionGalleryImages(currentVersionId, authorUserId, COM_BROWSING_LEVEL),
		);
	const storagePrefix =
		getStoragePrefixFromVersions(versions) ||
		extractStoragePrefix(model?.creator?.image) ||
		extractStoragePrefix(modelRed?.creator?.image);
	const restLookup = buildVersionImageLookup(currentVersion?.images);
	const mergedGalleryMedia = mergeAndResolveGalleryMedia(
		storagePrefix,
		imageLists,
		restLookup,
	).slice(0, GALLERY_MAX);
	onProgress?.("Fetching metadata…");
	const imageMetas = await buildImageMetas(mergedGalleryMedia);
	onProgress?.("Fetching creator info…");
	const creator = authorUserId
		? await trpc("user.getCreator", { id: authorUserId, authed: true }).catch(() => null)
		: null;
	const trpcVersion = await fetchTrpcVersion(modelId, currentVersionId);
	const creations = trpcVersion?.rank?.generationCountAllTime ?? null;

	onProgress?.("Assembling snapshot…");
	return {
		model: {
			name: model?.name || "",
			type: model?.type || "",
			version: currentVersion?.name || "",
			baseModel:
				currentVersion?.baseModel || currentVersion?.baseModelType || "",
			versions: versions.map((v) => ({
				name: v?.name || "",
				id: v?.id || "",
				createdAt: v?.createdAt || "",
			})),
		},
		author: {
			name: model?.creator?.username || "",
			joinDate:
				creator?.createdAt ||
				model?.creator?.createdAt ||
				modelRed?.creator?.createdAt ||
				"",
		},
		triggers: Array.isArray(currentVersion?.trainedWords)
			? currentVersion.trainedWords
			: [],
		usageTips: {
			strength: trpcVersion?.settings?.strength ?? null,
			clipSkip: trpcVersion?.clipSkip ?? null,
		},
		source: {
			host: window.location.hostname || "",
			modelId,
			datePublished:
				currentVersion?.publishedAt || currentVersion?.createdAt || "",
		},
		civitaiStats: {
			downloads:
				currentVersion?.stats?.downloadCount ??
				model?.stats?.downloadCount ??
				null,
			creations,
			reviews: {
				thumbsUpCount: currentVersion?.stats?.thumbsUpCount ?? null,
				thumbsDownCount: currentVersion?.stats?.thumbsDownCount ?? null,
			},
		},
		aboutVersion: currentVersion?.description || "",
		description: model?.description || "",
		comments: [],
		galleryMedia: mergedGalleryMedia.map((item) => ({
			url: item.url,
			kind: item.kind,
		})),
		imageMetas,
		infoCreated: new Date().toISOString(),
		userscriptVersion: getScriptVersion(),
	};
}

// --- info-data.js payload + HTML image rewrite ---
// Generated payload + media live under assets/; info.html and notes.js stay at ZIP root.
const ASSET_DIR = "assets/";

/** Queues the HTML's remote images for download; their `src` is set once the file format is known. */
function collectHtmlImages(html, media, baseName, useStandardMedia) {
	const div = document.createElement("div");
	div.innerHTML = html || "";
	let index = 0;
	div.querySelectorAll("img[src]").forEach((img) => {
		const src = img.getAttribute("src");
		if (!isHttpUrl(src)) return;
		const url = resolveExportMediaUrl(src, "image", useStandardMedia);
		if (!url) return;
		index += 1;
		media.push({ url, filename: baseName + "-" + index, img });
	});
	return div;
}

function formatLocalDateTimeForZipName(d) {
	const pad = (n) => String(n).padStart(2, "0");
	return (
		[d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join("-") +
		" " +
		[pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join("-")
	);
}

function downloadBlob(blob, filename) {
	const a = document.createElement("a");
	const url = URL.createObjectURL(blob);
	a.href = url;
	a.download = filename;
	a.click();
	setTimeout(() => URL.revokeObjectURL(url), 250);
}

// --- Embedded info.html (stylesheet + DOM template + offline script) ---
const INFO_HEAD_HTML = "<meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Model Info</title><base target=\"_blank\"><link rel=\"preconnect\" href=\"https://fonts.googleapis.com\"><link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin><link href=\"https://fonts.googleapis.com/css2?family=Cascadia+Mono:ital,wght@0,400;1,400&family=Fira+Sans+Condensed:ital,wght@0,400;0,500;1,400&display=swap\" rel=\"stylesheet\">";
const INFO_PAGE_CSS = "*,::after,::before{box-sizing:border-box;corner-shape:superellipse(1.2);scrollbar-color:var(--scrollbar-thumb) oklch(0% 0 0 / 0);scrollbar-width:thin}*{margin:0}html:focus-within{scroll-behavior:smooth}body{-webkit-font-smoothing:antialiased}canvas,img,picture,svg,video{display:block;max-width:100%}button,input,select,textarea{font:inherit}button{border:0;color:inherit}h1,h2,h3,h4,h5,h6,p{overflow-wrap:break-word}ol,ul{padding-inline-start:1.25em}:root{--br-s2:3px;--br-s1:6px;--br-m:12px;--br-full:9999px;--fs-s1:12px;--fs-m:14px;--fs-l1:18px;--sp-s4:2px;--sp-s3:4px;--sp-s2:6px;--sp-s1:8px;--sp-m:12px;--sp-l1:20px;--sp-l2:32px;--sp-l3:48px;--scrollbar-size:4px;--scrollbar-inset:9px;--scrollbar-offset:2px}body{display:grid;place-items:center;height:100dvh;overflow:hidden;background:var(--bg-body);color:var(--text);font-family:\"Fira Sans Condensed\",\"Lucida Grande\",\"Segoe UI\",sans-serif;font-size:var(--fs-m)}a{color:inherit;font-style:italic}h6{margin:0 0 var(--sp-m);font-size:var(--fs-m);font-weight:400}strong{font-weight:500}#root{--min-h:720px;--inset-y:clamp(var(--sp-s1), calc((100dvh - var(--min-h)) / 2), calc(100dvh * 96 / 1080));--ratio:1.76;display:flex;flex-direction:column;gap:var(--sp-s2);aspect-ratio:var(--ratio);min-width:calc(var(--min-h) * var(--ratio));max-width:calc(100vw - var(--sp-l1) * 2);height:calc(100dvh - var(--inset-y) * 2);padding:var(--sp-s1);overflow:hidden}#overview{display:grid;flex:1;grid-template-columns:2fr 3fr 2fr;grid-template-rows:minmax(0,1fr);gap:var(--sp-s2);min-height:0}#overview>.panel{min-width:0;min-height:0}#metadata>.scrollable{padding-bottom:var(--sp-m)}#notes{padding-bottom:var(--sp-l2)}#gallery{display:grid;gap:var(--sp-m);padding:var(--sp-l1)}#gallery:has(#media-wrap:not(.hidden)){grid-template-rows:minmax(0,1fr) auto auto}#stage{display:flex;align-items:center;justify-content:center;container-type:size;min-height:0;overflow-anchor:none}.hidden{display:none!important}.panel{position:relative;padding:var(--sp-s1);border-radius:var(--br-m);background:var(--bg-panel);background-clip:padding-box;box-shadow:var(--bsc-panel);overflow-wrap:anywhere}.panel:has(> .scrollable){padding:0}.panel::after{position:absolute;inset:0;z-index:1;border-radius:inherit;box-shadow:var(--bsc-panel-top);content:\"\";pointer-events:none}.stack{display:flex;flex-direction:column;gap:var(--sp-m)}.scrollable{height:100%;min-height:0;padding:var(--sp-s1);overflow-x:hidden;overflow-y:auto;border-radius:inherit;scrollbar-width:none}.overlay-scrollbar{display:none;position:fixed;z-index:110;width:var(--scrollbar-size);margin:var(--scrollbar-inset) 0 0 calc(0px - var(--scrollbar-size) - var(--scrollbar-offset));border-radius:4px;background:var(--scrollbar-thumb);touch-action:none}.overlay-scrollbar:hover{background:var(--scrollbar-thumb-h)}.overlay-scrollbar.is-active,.overlay-scrollbar:active{background:var(--scrollbar-thumb-a)}.overlay-scrollbar.is-visible{display:block}.heading{display:inline-block;padding:var(--sp-s4) var(--sp-m);border-radius:var(--br-full);corner-shape:round}.heading[data-tone=blue]{background:var(--blue);color:var(--blue-ink)}.heading[data-tone=yellow]{background:var(--yellow);color:var(--yellow-ink)}.heading[data-tone=red]{background:var(--red);color:var(--red-ink)}.btn{display:inline-flex;align-items:center;justify-content:center;padding:var(--sp-s4) var(--sp-m);border-radius:var(--br-full);appearance:none;background:var(--bg-btn);box-shadow:var(--bsc-btn);corner-shape:round;font-size:var(--fs-m);cursor:pointer;touch-action:manipulation;user-select:none;-webkit-tap-highlight-color:transparent}.btn:hover:not(:disabled){background:var(--bg-btn-h)}.btn:active:not(:disabled){background:var(--bg-btn-a);box-shadow:var(--bsc-btn-a);transform:translateY(var(--press-shift))}.btn:disabled{opacity:.5;cursor:not-allowed;pointer-events:none}.badge{display:flex;align-items:center;justify-content:center;min-width:0;padding:var(--sp-s4) var(--sp-l1);border-radius:var(--br-s1);overflow-wrap:anywhere;font-size:var(--fs-l1);text-align:center;text-transform:uppercase;white-space:normal}.pill{display:flex}.pill>.btn{flex:1;min-width:76px;padding:var(--sp-s2)}.pill>.btn:first-child{border-radius:var(--br-full) 0 0 var(--br-full)}.pill>.btn:last-child{border-radius:0 var(--br-full) var(--br-full) 0}.popover{--popover-tilt:-68deg;position:absolute;z-index:100;width:max-content;max-width:min(320px,85vw);box-shadow:var(--bsc-float);opacity:0;visibility:hidden;transform:perspective(140px) rotateX(var(--popover-tilt));transform-origin:0 top;transition:opacity .12s,transform .12s,visibility 0s linear .11s;pointer-events:none}.popover-trigger{position:relative;z-index:101}.popover.panel{background:var(--bg-float)}.popover .comment,.popover .version-chip{background:var(--bg-inner2)}.popover.is-open{opacity:1;visibility:visible;transform:perspective(140px) rotateX(0);transition:opacity .12s,transform .12s;pointer-events:auto}.popover.is-measuring{opacity:0;visibility:visible;transition:none;pointer-events:none}#load-error{text-align:center}#load-error h6{margin-bottom:var(--sp-s2)}#load-error p{margin:0 0 var(--sp-l2);color:var(--text-muted)}#header{display:flex;align-items:center;gap:var(--sp-s1);position:relative;min-width:0}#model-badges{display:flex;gap:var(--sp-s2);height:100%;max-width:40%;min-width:0}#base-model,#model-type{background:var(--bg-inner)}#model-type[data-type=\"checkpoint merge\"],#model-type[data-type=\"checkpoint trained\"],#model-type[data-type=checkpoint]{--tone:yellow;background:var(--yellow);color:var(--yellow-ink)}#model-type[data-type=\"aesthetic gradient\"],#model-type[data-type=dora],#model-type[data-type=embedding],#model-type[data-type=hypernetwork],#model-type[data-type=locon],#model-type[data-type=lora],#model-type[data-type=lycoris]{--tone:blue;background:var(--blue);color:var(--blue-ink)}#model-type[data-type=\"text encoder\"],#model-type[data-type=controlnet],#model-type[data-type=motion],#model-type[data-type=upscaler],#model-type[data-type=vae],#model-type[data-type=wildcards],#model-type[data-type=workflow],#model-type[data-type=workflows]{--tone:red;background:var(--red);color:var(--red-ink)}#model-name{flex:1;min-width:0;font-size:var(--fs-l1);font-weight:400}#title-actions{display:flex;align-items:center;flex-shrink:0;gap:var(--sp-s2);margin-left:auto}#theme-icon-sun,html.theme-dark #theme-icon-moon{display:none}html.theme-dark #theme-icon-sun{display:block}#theme-btn svg{width:1lh;height:1lh}#versions-popover{display:flex;flex-direction:column;align-items:flex-start;gap:var(--sp-s3)}.version-chip{max-width:100%;padding:var(--sp-s3) var(--sp-m);overflow:hidden;border-radius:var(--br-full);background:var(--bg-inner);font-size:var(--fs-s1);text-align:left;text-overflow:ellipsis;white-space:nowrap}#current-version-chip{background:var(--blue);font-weight:500}.meta{display:flex;flex-direction:column;gap:var(--sp-m)}.meta-header{display:flex;align-items:center;gap:var(--sp-s2)}.meta-header>h6{margin-bottom:0}#details>.stack>:not(.hidden)~:not(.hidden),.meta:not(.hidden)~.meta:not(.hidden){padding-top:var(--sp-m);border-top:1px solid var(--divider)}#details .heading{display:block;width:fit-content;margin-left:auto;margin-right:auto;text-align:center}#triggers-copy-btn{margin-left:auto;font-weight:500}.grid-meta{display:grid;grid-template-columns:1fr 1fr 1fr;gap:var(--sp-s1);padding:0 var(--sp-s1)}.flex-meta{display:flex;flex-wrap:wrap;gap:var(--sp-s1);min-width:0;padding:0 var(--sp-s1)}.flex-meta .btn{max-width:100%;min-width:0}.field label{display:block;margin-bottom:var(--sp-s4);font-size:var(--fs-s1);font-style:italic}.content{padding:0 var(--sp-s1)}.content h3{margin:0 0 var(--sp-s2);font-size:var(--fs-s1);font-weight:500}.comment-content p,.content p{margin-bottom:var(--sp-s1)}.comment-content p:last-child,.content p:last-child{margin-bottom:0}.content hr{height:1px;margin:var(--sp-m) 0;border:0;background:var(--divider)}.content img{height:auto}.content embed,.content iframe,.content object{display:block;max-width:100%;border:0}.content iframe{width:100%}.content pre{max-width:100%;margin-top:var(--sp-s2);margin-bottom:var(--sp-m);padding:var(--sp-s1) var(--sp-m);overflow-wrap:break-word;border-radius:var(--br-s1);background:var(--bg-inner);font-family:\"Cascadia Mono\",Menlo,monospace;font-size:var(--fs-s1);white-space:pre-wrap}.content code{padding:var(--sp-s4);border-radius:var(--br-s2);background:var(--bg-inner);font-family:\"Cascadia Mono\",Menlo,monospace;font-size:var(--fs-s1)}.comment-content pre code,.content pre code{padding:0;border-radius:0;background:0 0}#screenshot{margin-top:auto;padding-top:var(--sp-m);border-top:1px solid var(--divider);text-align:center}#media-wrap{display:inline-block;position:relative;padding:var(--sp-s1);border-radius:var(--br-s1);background:var(--bg-media-frame);box-shadow:var(--bs-media)}#media-wrap:has(#gallery-empty:not(.hidden)){display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;height:min(280px,calc(100cqh - var(--sp-m)));max-width:100%;color:var(--text-muted)}#gallery-copy-btn{position:absolute;top:var(--sp-m);right:var(--sp-m);z-index:2;opacity:0;white-space:nowrap;pointer-events:none}#media-wrap:focus-within #gallery-copy-btn,#media-wrap:hover #gallery-copy-btn{opacity:1;pointer-events:auto}#gallery-img,#gallery-video{height:auto;max-height:calc(95cqh - var(--sp-m));border-radius:var(--br-s2)}#gallery-counter{display:grid;grid-template-columns:1fr auto 1fr;justify-self:center;width:100%;max-width:80px;margin-block-start:var(--sp-s1);padding:var(--sp-s4) var(--sp-m);border-radius:var(--br-full);background:var(--bg-inner);color:var(--text-muted)}#gallery-counter>*{text-align:center}#gallery-nav{justify-self:center;width:100%;max-width:340px}.comment{padding:var(--sp-s1);border-radius:var(--br-s1);background:var(--bg-inner)}.comment-hidden{background:var(--bg-inner-alt)}.popover .comment+.comment{margin-top:var(--sp-s2)}#comments{display:grid;gap:var(--sp-s2)}.comment-header{display:flex;align-items:baseline;gap:var(--sp-s2);margin-bottom:var(--sp-s3)}.comment-author{flex:1;font-size:var(--fs-s1);font-style:italic}.comment-author a{text-decoration:none}.comment-date{color:var(--text-muted);font-size:var(--fs-s1)}.comment-hidden-label{font-size:var(--fs-s1);font-weight:500}.comment-content code{padding:var(--sp-s4);border-radius:var(--br-s2);background:var(--bg-panel);font-family:\"Cascadia Mono\",Menlo,monospace;font-size:var(--fs-s1)}.comment-content pre{max-width:100%;overflow-wrap:break-word;font-family:\"Cascadia Mono\",Menlo,monospace;font-size:var(--fs-s1);white-space:pre-wrap}.comment-footer{display:flex;align-items:center;gap:var(--sp-s2);margin-top:var(--sp-s1)}.comment-reactions{display:flex;flex-wrap:wrap;gap:var(--sp-s3);opacity:.5}.comment-reaction{display:inline-flex;align-items:center;padding:0 var(--sp-s1);border-radius:var(--br-full);background:var(--bg-btn);corner-shape:round}.comment-answers-btn{margin-left:auto;padding:0 var(--sp-s1)}.comment-answers-count,.comment-reaction-count{margin-left:var(--sp-s4);font-size:var(--fs-s1)}#load-all-btn{display:flex;width:fit-content;margin:var(--sp-m) auto var(--sp-s1) auto}#comment-answers-popover{display:flex;flex-direction:column;position:fixed;max-height:400px}#info-date{margin:var(--sp-s2) 0 0;color:var(--text-muted);font-size:var(--fs-s1);text-align:center}@media (hover:none){#gallery-copy-btn{opacity:1;pointer-events:auto}}@media (max-width:1399px){body{display:block;height:auto;overflow:auto}#root{min-width:0;max-width:none;height:auto;aspect-ratio:auto;padding:var(--sp-l1);overflow:visible}#header{align-items:stretch}#model-name{align-self:center}#overview{grid-template-columns:2fr 3fr;grid-template-rows:minmax(50dvh,auto) auto}#details{grid-column:1/-1}#details .scrollable{height:auto;overflow:visible}}@media (min-width:896px) and (max-width:1399px){#comments{grid-template-columns:1fr 1fr}#comments>.comment{display:grid;grid-template-rows:auto 1fr auto}}@media (max-width:895px){#root{padding:var(--sp-m)}#header{flex-direction:column}#model-badges{width:100%;max-width:none}#model-badges .badge{flex:1}#model-name{text-align:center}#title-actions{align-self:center;margin-left:0}#overview{flex:none;grid-template-columns:1fr;grid-template-rows:none}#gallery:has(#media-wrap:not(.hidden)){grid-template-rows:50dvh auto auto}#metadata .scrollable{height:auto;overflow:visible}}";
const INFO_THEME_LIGHT = ":root{--bg-body:oklch(88% 0 0);--bg-panel:oklch(100% 0 0);--bg-float:oklch(100% 0 0);--bg-inner:oklch(95% 0 0);--bg-inner-alt:oklch(96% 0.04 100);--bg-inner2:oklch(95% 0 0);--bg-media-frame:oklch(100% 0 0);--bg-btn:oklch(100% 0 0);--bg-btn-h:color-mix(in oklch, var(--bg-btn), black 3%);--bg-btn-a:color-mix(in oklch, var(--bg-btn), black 3%);--press-shift:1px;--text:oklch(0% 0 0 / 0.92);--text-muted:oklch(0% 0 0 / 0.32);--blue:oklch(92% 0.044 242);--yellow:oklch(94% 0.13 100);--red:oklch(92% 0.044 18);--ink-l:46%;--ink-c:0.18;--blue-ink:oklch(from var(--blue) var(--ink-l) var(--ink-c) h);--yellow-ink:oklch(from var(--yellow) calc(var(--ink-l) - 8%) var(--ink-c) h);--red-ink:oklch(from var(--red) var(--ink-l) var(--ink-c) h);--bs-rim:0 0 0 1px oklch(0% 0 0 / 0.13);--bs-d-hard-s2:0 1px 1px 0px oklch(0% 0 0 / 0.2);--bs-d-hard-s1:0 2px 0 0 oklch(0% 0 0 / 0.14);--bs-d-soft-m:0 3px 3px 0px oklch(0% 0 0 / 0.1);--bs-d-soft-l1:0 8px 48px 0 oklch(0% 0 0 / 0.36);--bs-media:0 0 1px 1px oklch(0% 0 0 / 0.25),0 4px 19px 0 oklch(0% 0 0 / 0.14),0 7px 10px -6px oklch(0% 0 0 / 0.85);--bsc-panel:var(--bs-d-hard-s1);--bsc-panel-top:var(--bs-rim);--bsc-btn:var(--bs-rim),var(--bs-d-hard-s1);--bsc-btn-a:inset var(--bs-rim),inset var(--bs-d-soft-m),inset var(--bs-d-hard-s2);--bsc-float:var(--bs-d-hard-s1),var(--bs-d-soft-l1);--divider:oklch(0% 0 0 / 0.08);--scrollbar-thumb:oklch(45% 0.03 242 / 0.38);--scrollbar-thumb-h:oklch(45% 0.03 242 / 0.5);--scrollbar-thumb-a:oklch(45% 0.03 242 / 0.62)}";
const INFO_THEME_DARK = ":root{--bg-body:linear-gradient(oklch(23% 0.04 18), oklch(13% 0.01 18)) oklch(23% 0.04 18);--bg-panel:linear-gradient(oklch(18% 0.05 260), oklch(15% 0.05 260));--bg-float:linear-gradient(oklch(23% 0.05 260), oklch(20% 0.05 260));--bg-inner:oklch(21% 0.05 260);--bg-inner-alt:oklch(24% 0.04 260);--bg-inner2:oklch(27% 0.05 260);--bg-media-frame:oklch(0% 0 0);--bg-btn:oklch(5% 0.05 260);--bg-btn-h:color-mix(in oklch, var(--bg-btn), white 14%);--bg-btn-a:color-mix(in oklch, var(--bg-btn), white 5%);--press-shift:1px;--text:oklch(100% 0 0 / 0.7);--text-muted:oklch(100% 0 0 / 0.2);--blue:oklch(30% 0.1 194);--yellow:oklch(36% 0.09 95);--red:oklch(32% 0.06 18);--ink-l:64%;--ink-c:0.12;--blue-ink:oklch(from var(--blue) var(--ink-l) var(--ink-c) h);--yellow-ink:oklch(from var(--yellow) calc(var(--ink-l) + 5%) var(--ink-c) h);--red-ink:oklch(from var(--red) var(--ink-l) var(--ink-c) h);--bs-rim:0 0 0 1px oklch(100% 0 0 / 0.05);--bs-l-hard-s1:0 1px 0 0 oklch(100% 0 0 / 0.12);--bs-l-r-hard-s1:0 -1px 0 0 oklch(100% 0 0 / 0.12);--bs-d-soft-m:0 2px 2px 0 oklch(0% 0 0 / 0.25);--bs-d-soft-l1:0 8px 48px 0 oklch(0% 0 0 / 0.95);--bs-media:0 0 1px 1px oklch(100% 0 0 / 0.3),0 4px 19px 0 oklch(0% 0 0 / 0.14),0 7px 10px -6px oklch(0% 0 0 / 0.85);--bsc-panel:var(--bs-d-soft-m);--bsc-panel-top:inset var(--bs-l-hard-s1),inset var(--bs-rim);--bsc-btn:var(--bs-l-r-hard-s1),var(--bs-d-soft-m);--bsc-btn-a:var(--bs-l-hard-s1);--bsc-float:var(--bs-d-soft-l1);--divider:oklch(100% 0 0 / 0.12);--scrollbar-thumb:oklch(58% 0.02 260 / 0.38);--scrollbar-thumb-h:oklch(58% 0.02 260 / 0.5);--scrollbar-thumb-a:oklch(58% 0.02 260 / 0.62)}";
const INFO_BODY_HTML = "<div id=\"root\"><div id=\"load-error\" class=\"panel hidden\"><h6>Could not load</h6><p>Ensure <code>info.html</code> is in the same folder as <code>info-data.js</code> and <code>notes.js</code> (from the download).</p></div><div id=\"header\" class=\"panel hidden\"><div id=\"model-badges\"><div id=\"base-model\" class=\"badge hidden\" title=\"Base Model\"></div><div id=\"model-type\" class=\"badge hidden\" title=\"Model Type\"></div></div><h5 id=\"model-name\"></h5><div id=\"title-actions\"><button type=\"button\" id=\"versions-btn\" class=\"btn hidden\" title=\"Show the model's version list\"></button> <button type=\"button\" id=\"theme-btn\" class=\"btn\" title=\"Switch to dark theme\" aria-label=\"Switch to dark theme\"><svg id=\"theme-icon-moon\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><path fill=\"currentColor\" d=\"M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z\"/></svg> <svg id=\"theme-icon-sun\" viewBox=\"0 0 24 24\" aria-hidden=\"true\"><circle cx=\"12\" cy=\"12\" r=\"4\" fill=\"currentColor\"/><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-width=\"2\" d=\"M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41\"/></svg></button></div><div id=\"versions-popover\" class=\"panel popover\"><div id=\"current-version-chip\" class=\"version-chip\"></div></div></div><div id=\"overview\" class=\"hidden\"><div id=\"metadata\" class=\"panel\"><div class=\"stack scrollable\"><div id=\"author\" class=\"meta hidden\"><div class=\"meta-header\"><h6 class=\"heading\">Author</h6></div><div class=\"grid-meta\"><div id=\"author-name\" class=\"field\"><label>Name</label> <a class=\"value\"></a></div><div id=\"author-joined\" class=\"field\"><label>Joined</label><div class=\"value\"></div></div></div></div><div id=\"triggers\" class=\"meta hidden\"><div class=\"meta-header\"><h6 class=\"heading\">Triggers</h6><button type=\"button\" id=\"triggers-copy-btn\" class=\"btn hidden\" data-copy-ref=\"all\">Copy All</button></div><div class=\"flex-meta\"></div></div><div id=\"usage-tips\" class=\"meta hidden\"><div class=\"meta-header\"><h6 class=\"heading\">Usage tips</h6></div><div class=\"grid-meta\"><div id=\"strength\" class=\"field\"><label>Strength</label><div class=\"value\"></div></div><div id=\"clip-skip\" class=\"field\"><label>Clip skip</label><div class=\"value\"></div></div></div></div><div id=\"source\" class=\"meta hidden\"><div class=\"meta-header\"><h6 class=\"heading\">Source</h6></div><div class=\"grid-meta\"><div id=\"source-link\" class=\"field\"><label>Link</label> <a class=\"value\"></a></div><div id=\"source-published\" class=\"field\"><label>Published</label><div class=\"value\"></div></div></div><div class=\"content\"><div id=\"original-file-name\" class=\"field\"><label>Original file name</label><div class=\"value\"></div></div></div></div><div id=\"civitai-stats\" class=\"meta hidden\"><div class=\"meta-header\"><h6 class=\"heading\">Civitai stats</h6></div><div class=\"grid-meta\"><div id=\"downloads\" class=\"field\"><label>Downloads</label><div class=\"value\"></div></div><div id=\"creations\" class=\"field\"><label>Creations</label><div class=\"value\"></div></div><div id=\"reviews\" class=\"field\"><label>Reviews</label><div class=\"value\"></div></div></div></div><div id=\"notes\" class=\"meta hidden\"><div class=\"meta-header\"><h6 class=\"heading\">Notes</h6></div><div class=\"content\"></div></div><div id=\"screenshot\" class=\"hidden\"><button type=\"button\" id=\"screenshot-btn\" class=\"btn\">Show Screenshot</button></div></div></div><div id=\"gallery\" class=\"panel\"><div id=\"stage\"><div id=\"media-wrap\" class=\"hidden\"><div id=\"gallery-empty\" class=\"hidden\">No media</div><img id=\"gallery-img\" alt=\"\"><video id=\"gallery-video\" class=\"hidden\" controls loop muted playsinline></video><button type=\"button\" id=\"gallery-copy-btn\" class=\"btn hidden\" data-copy-ref=\"gallery\" title=\"Copy this image's generation parameters as JSON to clipboard\">Copy Metadata</button></div></div><div id=\"gallery-counter\" class=\"hidden\"><span id=\"gallery-counter-current\"></span> <span id=\"gallery-counter-sep\"><strong>·</strong></span> <span id=\"gallery-counter-total\"></span></div><div id=\"gallery-nav\" class=\"pill hidden\"><button type=\"button\" id=\"gallery-prev-btn\" class=\"btn\">Previous</button> <button type=\"button\" id=\"gallery-next-btn\" class=\"btn\">Next</button></div></div><div id=\"details\" class=\"panel\"><div class=\"stack scrollable\"><div id=\"about-version\" class=\"hidden\"><h6 class=\"heading\">About this version</h6><div class=\"content\"></div></div><div id=\"description\" class=\"hidden\"><h6 class=\"heading\">Description</h6><div class=\"content\"></div></div><div id=\"discussion\" class=\"hidden\"><h6 class=\"heading\">Discussion</h6><div id=\"comments\"></div></div></div></div></div><div id=\"comment-answers-popover\" class=\"panel popover\"><div class=\"scrollable\"></div></div><p id=\"info-date\" class=\"hidden\"></p></div>";
const INFO_SCRIPT = "!function(){\"use strict\";var e=null,t=\"\",n=\"\",r=[],o=[],i=0;function a(e,t){var n=document.getElementById(e);return t?n.querySelector(t):n}function s(e){e.classList.remove(\"hidden\")}function c(e){e.classList.add(\"hidden\")}function l(e){if(!e)return\"\";var t=document.createElement(\"div\");return t.textContent=e,t.innerHTML}var u=new Intl.DateTimeFormat(\"en-US\",{month:\"long\",timeZone:\"UTC\"});function d(e,t){if(null==e||\"\"===String(e).trim())return\"\";var n=new Date(String(e));if(isNaN(n.getTime()))return\"\";var r=u.format(n),o=n.getUTCFullYear()+\", \"+r+\" \"+n.getUTCDate();if(t){var i=function(e){return String(e).padStart(2,\"0\")};o+=\", \"+i(n.getUTCHours())+\":\"+i(n.getUTCMinutes())}return o}function m(e,t){var n=d(t),r=d(t,!0);if(!n)return e.textContent=v,void e.removeAttribute(\"title\");e.textContent=n,r&&r!==n?e.setAttribute(\"title\",r):e.removeAttribute(\"title\")}var v=\"-\",p={Like:\"👍\",Dislike:\"👎\",Heart:\"❤️\",Laugh:\"😂\",Cry:\"😢\"};function f(t,n){var r,o,i,a,s,c,u,m=(r=t.reactions,o={},Array.isArray(r)?r.forEach(function(e){var t=e&&null!=e.reaction?String(e.reaction).trim():\"\";t&&(o[t]=(o[t]||0)+1)}):r&&\"object\"==typeof r&&Object.keys(r).forEach(function(e){var t=Number(r[e])||0;t>0&&(o[e]=t)}),Object.keys(o).map(function(e){return'<span class=\"comment-reaction\">'+(p[e]||l(e))+'<span class=\"comment-reaction-count\">'+o[e]+\"</span></span>\"}).join(\"\")),v=m||n?'<div class=\"comment-footer\">'+(m?'<div class=\"comment-reactions\">'+m+\"</div>\":\"\")+(n||\"\")+\"</div>\":\"\",f=L((e.source||{}).host,t.commenterName);return'<div class=\"comment-header\"><span class=\"comment-author\">'+(f?'<a href=\"'+l(f)+'\">'+l(t.commenterName||\"\")+\"</a>\":l(t.commenterName||\"\"))+\"</span>\"+(i=t.commentDate,a=t.hidden,s=d(i),c=d(i,!0),u=[],a&&u.push('<span class=\"comment-hidden-label\">Hidden</span>'),s&&u.push('<span class=\"comment-date\"'+(c&&c!==s?' title=\"'+l(c)+'\"':\"\")+\">\"+l(s)+\"</span>\"),u.join(\"\")+'</div><div class=\"comment-content\">')+(t.content||\"\")+\"</div>\"+v}function h(e){return e&&e.hidden?\"comment comment-hidden\":\"comment\"}function g(e){e.classList.remove(\"is-open\"),e._anchor&&e._anchor.classList.remove(\"popover-trigger\"),e._anchor=null}function y(e,t,n){e._anchor&&e._anchor!==n&&e._anchor.classList.remove(\"popover-trigger\"),e.classList.add(\"is-measuring\"),function(e,t,n){var r=\"fixed\"===getComputedStyle(e).position?{left:0,top:0}:t.getBoundingClientRect(),o=n.getBoundingClientRect(),i=e.offsetWidth,a=e.offsetHeight,s=o.left+o.width/2>window.innerWidth/2,c=o.top+o.height/2>window.innerHeight/2,l=Math.max(0,s?o.right-r.left-i:o.left-r.left);e.style.left=l+\"px\",e.style.top=(c?o.top-r.top-a-4:o.bottom-r.top+4)+\"px\",e.style.transformOrigin=(s?i-o.width/2:o.width/2)+\"px \"+(c?\"bottom\":\"top\"),e.style.setProperty(\"--popover-tilt\",c?\"68deg\":\"-68deg\")}(e,t,n),e.offsetWidth,e.classList.remove(\"is-measuring\"),e.classList.add(\"is-open\"),n.classList.add(\"popover-trigger\"),e._anchor=n}function b(){var t=a(\"discussion\"),n=a(\"comment-answers-popover\"),r=null;function o(e){n.contains(e.target)||i()}function i(){g(n),N(n.querySelector(\".scrollable\")),r&&(document.removeEventListener(\"click\",r),r=null),document.removeEventListener(\"scroll\",o,!0)}t&&n&&t.addEventListener(\"click\",function(a){var s=a.target.closest(\".comment-answers-btn\");if(s){a.stopPropagation();var c=Number(s.getAttribute(\"data-comment-index\"));if(e&&Array.isArray(e.comments)&&!isNaN(c)&&e.comments[c]){var l=e.comments[c];if(n.classList.contains(\"is-open\")&&n._anchor===s)i();else{i();var u,d=n.querySelector(\".scrollable\");d.innerHTML=(u=l.answerComments,Array.isArray(u)&&u.length?u.map(function(e){return'<div class=\"'+h(e)+'\">'+f(e,\"\")+\"</div>\"}).join(\"\"):'<div class=\"comment\">'+v+\"</div>\"),d.scrollTop=0,d._overlayOpening=!0,O(d),y(n,t,s),function(e,t){var n=!1;function r(o){o&&o.target!==e||n||(n=!0,t._overlayOpening=!1,e.removeEventListener(\"transitionend\",r),t._overlayPlace(t.matches(\":hover\")))}e.addEventListener(\"transitionend\",r),setTimeout(r,150)}(n,d),r=function(e){n.contains(e.target)||s.contains(e.target)||i()},setTimeout(function(){document.addEventListener(\"click\",r)},0),document.addEventListener(\"scroll\",o,!0)}}}})}function L(e,t){return null==t||\"\"===String(t).trim()?\"\":e?\"https://\"+e+\"/user/\"+encodeURIComponent(String(t).trim()):\"\"}var w=\"string\"==typeof window.ASSET_BASE?window.ASSET_BASE:\"\";function E(e){r=e||[],i=0;var t=a(\"gallery\"),n=a(\"stage\"),o=a(\"media-wrap\"),l=a(\"gallery-img\"),u=a(\"gallery-video\"),d=a(\"gallery-empty\"),m=a(\"gallery-counter\"),v=a(\"gallery-counter-current\"),p=a(\"gallery-counter-total\"),f=a(\"gallery-nav\"),h=a(\"gallery-prev-btn\"),g=a(\"gallery-next-btn\"),y=a(\"gallery-copy-btn\");function b(){c(l),l.removeAttribute(\"src\")}function L(){c(u),u.pause(),u.removeAttribute(\"src\")}if(!r.length)return b(),L(),s(n),s(o),s(d),s(t),c(m),c(f),void c(y);function w(e){i=e,v.textContent=String(e+1);var t=r[e];\"video\"===t.kind?function(e){b(),s(u),u.src=e,u.load();var t=u.play();t&&\"function\"==typeof t.catch&&t.catch(function(){})}(t.src):function(e,t){L(),s(l),l.alt=\"Preview \"+(t+1)+\" of \"+r.length,l.src=e}(t.src,e),(A()?s:c)(y)}c(d),s(n),s(o),s(t),p.textContent=String(r.length),s(m),h.onclick=function(){w((i-1+r.length)%r.length)},g.onclick=function(){w((i+1)%r.length)},r.length>1?(s(f),document.addEventListener(\"keydown\",function(e){var t={ArrowLeft:-1,a:-1,A:-1,ArrowRight:1,d:1,D:1}[e.key],n=e.target;!t||e.altKey||e.ctrlKey||e.metaKey||e.shiftKey||n&&(n.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)||\"VIDEO\"===n.tagName&&/^Arrow/.test(e.key))||(e.preventDefault(),e.stopPropagation(),(t<0?h:g).onclick())},!0)):c(f),w(0)}function A(){var e=o[i];return e&&\"object\"==typeof e?e:null}var C={TextualInversion:\"Embedding\",TextEncoder:\"Text Encoder\",AestheticGradient:\"Aesthetic Gradient\",MotionModule:\"Motion\"};var x,T=[\"blue\",\"yellow\",\"red\"];function S(){if(e){var r=e.model||{},o=e.author||{},i=e.source||{},u=e.civitaiStats||{},p=function(e){var t=null!=e?String(e).trim():\"\";if(!t)return\"\";var n=Object.keys(C).find(function(e){return e.toLowerCase()===t.toLowerCase()});return n?C[n]:t}(r.type),y=r.name&&String(r.name).trim()||\"\",b=r.baseModel&&String(r.baseModel).trim()||\"\";a(\"model-name\").textContent=y||\"Model\",document.title=\"Info - \"+(y||\"Model\");var w=a(\"model-type\");w.setAttribute(\"data-type\",p.toLowerCase()),w.textContent=p||v,s(w),a(\"base-model\").textContent=b||v,s(a(\"base-model\"));var E=function(e){var t=e.versions&&Array.isArray(e.versions)?e.versions:[],n=a(\"versions-btn\"),r=a(\"versions-popover\"),o=a(\"current-version-chip\"),i=(e.version||\"\").trim(),l={},u=document.createDocumentFragment();return i||t.some(function(e){var t=e&&e.name?String(e.name).trim():\"\";return!!t&&(i=t,!0)}),o.textContent=i||\"Version\",t.forEach(function(e){var t=e&&e.name?String(e.name).trim():\"\";if(t&&!l[t])if(l[t]=1,t!==i){var n=document.createElement(\"div\");n.className=\"version-chip\",n.textContent=t,u.appendChild(n)}else u.appendChild(o)}),i&&l[i]||u.insertBefore(o,u.firstChild),r.textContent=\"\",r.appendChild(u),(i?s:c)(n),i}(r),A=a(\"versions-btn\");A&&(A.textContent=E||\"Version\");var x=a(\"author-name\",\".value\");x.textContent=null!=o.name&&\"\"!==String(o.name).trim()?String(o.name):v;var S=L(i.host,o.name);S?x.setAttribute(\"href\",S):x.removeAttribute(\"href\"),m(a(\"author-joined\",\".value\"),o.joinDate),s(a(\"author\")),function(e){var t=a(\"triggers\"),n=t&&t.querySelector(\".flex-meta\"),r=a(\"triggers-copy-btn\");if(n){var o=(e||[]).map(function(e){return String(e||\"\").trim()}).filter(Boolean);n.innerHTML=\"\",r&&(o.length>1?(r.textContent=\"Copy All\",r.setAttribute(\"data-copy\",o.join(\", \")),s(r)):(c(r),r.removeAttribute(\"data-copy\"))),o.length?(o.forEach(function(e){var t=e.indexOf(\",\"),r=e;t>0&&t<=24?r=e.slice(0,t).trim():e.length>24&&(r=e.slice(0,24).trim());var o=document.createElement(\"button\");o.type=\"button\",o.className=\"btn\",o.setAttribute(\"data-copy-ref\",\"tw\"),o.setAttribute(\"data-copy\",e),o.title=e,o.textContent=r!==e?r+\" …\":e,n.appendChild(o)}),s(t)):c(t)}}(e.triggers);var k=e.usageTips||{},M=null!=k.strength,_=null!=k.clipSkip;a(\"strength\",\".value\").textContent=M?String(k.strength):\"\",a(\"clip-skip\",\".value\").textContent=_?String(k.clipSkip):\"\",(M?s:c)(a(\"strength\")),(_?s:c)(a(\"clip-skip\")),(M||_?s:c)(a(\"usage-tips\"));var N=a(\"source-link\",\".value\"),O=Number(i.modelId),P=Number.isFinite(O)&&O>0&&i.host?\"https://\"+i.host+\"/models/\"+O:\"\";N.textContent=P?i.host[0].toUpperCase()+i.host.slice(1):v,P?N.setAttribute(\"href\",P):N.removeAttribute(\"href\"),m(a(\"source-published\",\".value\"),i.datePublished),a(\"original-file-name\",\".value\").textContent=String(n||\"\").trim()||v,s(a(\"source\")),a(\"downloads\",\".value\").textContent=null!=u.downloads?String(u.downloads):v,a(\"creations\",\".value\").textContent=null!=u.creations?String(u.creations):v,a(\"reviews\",\".value\").textContent=function(e){if(!e||\"object\"!=typeof e)return\"\";var t=Number(e.thumbsUpCount),n=Number(e.thumbsDownCount),r=(t=isNaN(t)?0:t)+(n=isNaN(n)?0:n);if(!r)return\"No reviews yet\";var o=t/r;return(o<.2?r<10?\"Mixed\":r<50?\"Negative\":r<500?\"Very Negative\":\"Overwhelmingly Negative\":o<.4?\"Mostly Negative\":o<.7?\"Mixed\":o<.8?\"Mostly Positive\":r<50?\"Positive\":r<500||o<.95?\"Very Positive\":\"Overwhelmingly Positive\")+\" (\"+r.toLocaleString()+\")\"}(u.reviews)||v,s(a(\"civitai-stats\")),a(\"about-version\",\".content\").innerHTML=e.aboutVersion&&\"\"!==String(e.aboutVersion).trim()?e.aboutVersion:v,s(a(\"about-version\")),a(\"description\",\".content\").innerHTML=e.description&&\"\"!==String(e.description).trim()?e.description:v,s(a(\"description\"));var D=e.comments||[],j=a(\"discussion\"),I=a(\"comment-answers-popover\"),R=a(\"comments\");R.innerHTML=\"\";var V=a(\"load-all-btn\");if(V&&V.remove(),D.length){function Y(e,t){var n=Number(e.answers),r=Number.isFinite(n)&&n>0?'<button type=\"button\" class=\"btn comment-answers-btn\" data-comment-index=\"'+t+'\">💬<span class=\"comment-answers-count\">'+l(String(n))+\"</span></button>\":\"\";return'<div class=\"'+h(e)+'\">'+f(e,r)+\"</div>\"}var F=D.slice(0,20).map(Y).join(\"\");if(R.insertAdjacentHTML(\"beforeend\",F),D.length>20){var B=document.createElement(\"button\");B.type=\"button\",B.id=\"load-all-btn\",B.className=\"btn\",B.textContent=\"Load Rest \"+(D.length-20),B.onclick=function(){R.insertAdjacentHTML(\"beforeend\",D.slice(20).map(function(e,t){return Y(e,20+t)}).join(\"\")),B.remove(),H()},j.appendChild(B)}}else R.insertAdjacentHTML(\"beforeend\",'<div class=\"comment\">'+v+\"</div>\");I&&g(I),s(j);var U=e.infoCreated,q=' by <a href=\"https://github.com/ufuksarp\" target=\"_blank\" rel=\"noopener\">ufuksarp</a>\\'s Civitai Model Info Saver v'+l(e.userscriptVersion&&String(e.userscriptVersion).trim()?e.userscriptVersion:v)+\" userscript.\";a(\"info-date\").innerHTML=\"This info page was created at \"+l(U?d(U,!0)||U:v)+q,s(a(\"info-date\")),a(\"notes\",\".content\").innerHTML=String(t||\"\").trim()?t:\"You haven't added any notes to <i>notes.js</i> yet.\",s(a(\"notes\")),function(){var e=a(\"model-type\"),t=(e&&!e.classList.contains(\"hidden\")?getComputedStyle(e).getPropertyValue(\"--tone\"):\"\").trim(),n=T.indexOf(t),r=n<0?1:(n+1)%3;document.querySelectorAll(\".heading\").forEach(function(e){e.closest(\".hidden\")?e.removeAttribute(\"data-tone\"):e.setAttribute(\"data-tone\",T[r++%3])})}(),H()}}function k(){if(void 0!==window.MODEL_INFO){var r=window.MODEL_INFO;!function(r,i){e=r,t=window.MODEL_NOTES||\"\",n=window.ORIGINAL_FILE_NAME||\"\",o=r&&Array.isArray(r.imageMetas)?r.imageMetas:[],c(a(\"load-error\")),s(a(\"header\")),s(a(\"overview\")),S(),E(i||[])}(r,(r.galleryMedia&&Array.isArray(r.galleryMedia)?r.galleryMedia:[]).map(function(e){return{kind:e.kind,src:w+e.file}}))}else s(a(\"load-error\"))}var M=[];function _(e){var t=e.clientHeight,n=Math.max(0,t-2*x);return{track:n,max:e.scrollHeight-t,thumbH:Math.min(n,Math.max(24,t/e.scrollHeight*n))}}function N(e){clearTimeout(e._overlayHide),e._overlayThumb&&e._overlayThumb.classList.remove(\"is-visible\")}function H(e){var t=e&&e.target;t&&t._overlayPlace?t._overlayPlace(!0):M.forEach(function(e){e._overlayPlace(!1)})}function O(e){if(e._overlayPlace)e._overlayPlace(!1);else{M.length||(x=parseFloat(getComputedStyle(document.documentElement).getPropertyValue(\"--scrollbar-inset\")),document.addEventListener(\"scroll\",H,{capture:!0,passive:!0}),window.addEventListener(\"resize\",H)),M.push(e);var t=document.createElement(\"span\");t.className=\"overlay-scrollbar\",t.setAttribute(\"aria-hidden\",\"true\"),a(\"root\").appendChild(t),e._overlayThumb=t;var n=e.closest(\".popover\"),r=!1;e._overlayPlace=s,[e,t].forEach(function(e){e.addEventListener(\"pointerenter\",function(){s(!0)}),e.addEventListener(\"pointerleave\",function(){i(500)})}),t.addEventListener(\"wheel\",function(t){e.scrollTop+=t.deltaY,t.preventDefault()},{passive:!1}),t.addEventListener(\"pointerdown\",function(n){if(!n.button){n.preventDefault();var a=_(e);if(!(a.max<=0)){r=!0,t.classList.add(\"is-active\");var s=n.clientY,c=e.scrollTop,l=a.track>a.thumbH?a.max/(a.track-a.thumbH):0;document.addEventListener(\"pointermove\",u),document.addEventListener(\"pointerup\",function e(){r=!1,t.classList.remove(\"is-active\"),document.removeEventListener(\"pointermove\",u),document.removeEventListener(\"pointerup\",e),o()||i(500)})}}function u(t){e.scrollTop=c+(t.clientY-s)*l}}),e.addEventListener(\"mousedown\",function(t){if(!(1!==t.button||t.target.closest(\"a\")||e.scrollHeight<=e.clientHeight)){t.preventDefault();var n,r=t.clientY,o=r,i=e.scrollTop,a=!1,s=document.documentElement;s.style.cursor=\"ns-resize\",document.addEventListener(\"mousemove\",c),document.addEventListener(\"mouseup\",u),document.addEventListener(\"mousedown\",d,!0),n=requestAnimationFrame(function t(){var s=o-r;Math.abs(s)>8&&(a=!0,i+=(s-8*Math.sign(s))/8,i=Math.max(0,Math.min(e.scrollHeight-e.clientHeight,i)),e.scrollTop=i),n=requestAnimationFrame(t)})}function c(e){o=e.clientY}function l(){cancelAnimationFrame(n),s.style.cursor=\"\",document.removeEventListener(\"mousemove\",c),document.removeEventListener(\"mouseup\",u),document.removeEventListener(\"mousedown\",d,!0)}function u(e){1===e.button&&a&&l()}function d(e){e.preventDefault(),e.stopPropagation(),l()}}),s(!1)}function o(){return e.matches(\":hover\")||t.matches(\":hover\")}function i(t){clearTimeout(e._overlayHide),e._overlayHide=setTimeout(function(){r||o()||N(e)},t)}function s(a){var s=_(e);if(e._overlayOpening||s.max<=0||n&&!n.classList.contains(\"is-open\"))N(e);else{var c=e.getBoundingClientRect();t.style.height=s.thumbH+\"px\",t.style.top=c.top+e.scrollTop/s.max*(s.track-s.thumbH)+\"px\",t.style.left=c.right+\"px\",(a||r)&&(t.classList.add(\"is-visible\"),r||o()?clearTimeout(e._overlayHide):i(280))}}}function P(){var e,t,n;!function(){var e=a(\"theme-btn\"),t=document.getElementById(\"theme-light\"),n=document.getElementById(\"theme-dark\");function r(r){t.media=\"all\",n.media=\"all\",\"dark\"===r?(document.documentElement.classList.add(\"theme-dark\"),t.disabled=!0,n.disabled=!1,e.title=\"Switch to light theme\"):(document.documentElement.classList.remove(\"theme-dark\"),t.disabled=!1,n.disabled=!0,e.title=\"Switch to dark theme\"),e.setAttribute(\"aria-label\",e.title)}e&&t&&n&&(r(matchMedia(\"(prefers-color-scheme: dark)\").matches?\"dark\":\"light\"),e.onclick=function(){r(document.documentElement.classList.contains(\"theme-dark\")?\"light\":\"dark\")})}(),e=a(\"header\"),t=a(\"versions-popover\"),(n=a(\"versions-btn\")).onclick=function(r){r.stopPropagation(),t.classList.contains(\"is-open\")?g(t):(y(t,e,n),setTimeout(function(){document.addEventListener(\"click\",function e(r){t.contains(r.target)||r.target===n||(g(t),document.removeEventListener(\"click\",e))})},0))},b(),function(){var e=a(\"screenshot\"),t=a(\"screenshot-btn\");if(e&&t){var n=new Image;n.onload=function(){s(e),t.onclick=function(){window.open(\"screenshot.png\",\"_blank\")}},n.src=\"screenshot.png\"}}(),O(a(\"metadata\",\".scrollable\")),O(a(\"details\",\".scrollable\")),document.body.addEventListener(\"click\",function(e){var t=e.target;if(t&&t.closest){var n=t.closest(\"[data-copy-ref]\");if(n){var r;if(\"gallery\"===n.getAttribute(\"data-copy-ref\")){var o=A();r=o?JSON.stringify(o,null,2):\"\"}else r=n.getAttribute(\"data-copy\")||\"\";!function(e){e&&navigator.clipboard.writeText(e).catch(function(){})}(r),function(e){if(e){var t=e.getAttribute(\"data-copy-label\");if(null==t){t=e.textContent||\"\",e.setAttribute(\"data-copy-label\",t),e.setAttribute(\"data-copy-width\",e.style.width||\"\"),e.setAttribute(\"data-copy-height\",e.style.height||\"\");var n=e.getBoundingClientRect(),r=n.width,o=n.height;r>0&&(e.style.width=r+\"px\"),o>0&&(e.style.height=o+\"px\")}e._copyRestoreTimer&&clearTimeout(e._copyRestoreTimer),e.textContent=\"✓\",e._copyRestoreTimer=setTimeout(function(){e.textContent=t,e.style.width=e.getAttribute(\"data-copy-width\")||\"\",e.style.height=e.getAttribute(\"data-copy-height\")||\"\",e.removeAttribute(\"data-copy-label\"),e.removeAttribute(\"data-copy-width\"),e.removeAttribute(\"data-copy-height\"),e._copyRestoreTimer=0},1e3)}}(n)}}}),k()}document.addEventListener(\"touchstart\",function(){},{passive:!0}),\"loading\"===document.readyState?document.addEventListener(\"DOMContentLoaded\",P):P()}();";

function themeStylesheetLink(id, css, media) {
	return (
		'<link id="' + id + '" rel="stylesheet" href="data:text/css,' +
		encodeURIComponent(css) + '" media="' + media + '">'
	);
}

function generateInfoHtml() {
	return (
		'<!DOCTYPE html><html lang="en"><head>' + INFO_HEAD_HTML +
		"<style>" + INFO_PAGE_CSS + "</style>" +
		themeStylesheetLink("theme-light", INFO_THEME_LIGHT, "(prefers-color-scheme: light)") +
		themeStylesheetLink("theme-dark", INFO_THEME_DARK, "(prefers-color-scheme: dark)") +
		"</head><body>" + INFO_BODY_HTML +
		"<script>window.ASSET_BASE=" + JSON.stringify(ASSET_DIR) + ";<\/script>" +
		'<script src="' + ASSET_DIR + 'info-data.js"><\/script><script src="notes.js"><\/script><script>' +
		INFO_SCRIPT + "<\/script></body></html>"
	);
}

// --- Model page: export dock (panel UI + archive build) ---
async function runDownload() {
	const btn = document.getElementById("cmis-download");
	const status = document.getElementById("cmis-status");
	function setStatus(text) {
		if (status) status.textContent = text;
	}
	if (btn) {
		btn.disabled = true;
		btn.classList.add("hidden");
	}
	if (status) status.classList.remove("hidden");

	try {
		const zipLib = typeof zip !== "undefined" ? zip : window.zip;
		if (!zipLib) throw new Error("zip.js library failed to load");

		const data = await getModelData(setStatus);

		const useStandardMedia = !readBoolPref("cmis_pref_full_media", false);

		const gallery = data.galleryMedia.map((item, idx) => ({
			url: resolveExportMediaUrl(item.url, item.kind, useStandardMedia),
			filename: "gallery-" + (idx + 1),
			kind: item.kind,
		}));
		const media = [...gallery];
		const descriptionEl = collectHtmlImages(data.description, media, "description", useStandardMedia);
		const aboutVersionEl = collectHtmlImages(data.aboutVersion, media, "about", useStandardMedia);

		let done = 0;
		const mediaBuffers = [];
		setStatus("Downloading media 0/" + media.length + "…");
		for (let i = 0; i < media.length; i += MEDIA_CONCURRENCY) {
			const chunk = media.slice(i, i + MEDIA_CONCURRENCY);
			const results = await Promise.all(
				chunk.map((row) => fetchMediaBuffer(row.url)),
			);
			for (let j = 0; j < results.length; j += 1) {
				const result = results[j];
				if (result.err) {
					setStatus(chunk[j].filename + " " + result.err);
					return;
				}
				mediaBuffers[i + j] = result.buf;
			}
			done += chunk.length;
			setStatus("Downloading media " + done + "/" + media.length + "…");
		}
		media.forEach((row, k) => {
			const ext = sniffMediaExt(mediaBuffers[k]) || mediaExt(row.url) || "bin";
			row.file = row.filename + "." + ext;
			row.img?.setAttribute("src", ASSET_DIR + row.file);
		});
		data.description = descriptionEl.innerHTML;
		data.aboutVersion = aboutVersionEl.innerHTML;

		const comments = await fetchComments(data.source.modelId, setStatus);
		data.comments = (await fetchReplies(comments, setStatus)).map((c) =>
			mapCommentRow(c, true),
		);

		const infoObj = {
			...data,
			galleryMedia: gallery.map((row) => ({ kind: row.kind, file: row.file })),
		};
		const infoDataJs =
			"window.MODEL_INFO = " + JSON.stringify(infoObj) + ";\n";
		const notesJs =
			'window.MODEL_NOTES = ""; // Add notes here. HTML allowed.\nwindow.ORIGINAL_FILE_NAME = "";\n';
		const infoHtml = generateInfoHtml();

		setStatus("Adding info files to ZIP…");
		if (typeof zipLib.configure === "function") {
			zipLib.configure({ useWebWorkers: false });
		}
		const zipBlobWriter = new zipLib.BlobWriter("application/zip");
		const zipWriter = new zipLib.ZipWriter(zipBlobWriter);
		await zipWriter.add("info.html", new zipLib.TextReader(infoHtml));
		await zipWriter.add("notes.js", new zipLib.TextReader(notesJs));
		await zipWriter.add(ASSET_DIR + "info-data.js", new zipLib.TextReader(infoDataJs));

		for (let k = 0; k < media.length; k += 1) {
			const row = media[k];
			await zipWriter.add(
				ASSET_DIR + row.file,
				new zipLib.BlobReader(new Blob([new Uint8Array(mediaBuffers[k])])),
			);
		}

		setStatus("Finalizing ZIP…");
		await zipWriter.close();
		const zipBlob = await zipBlobWriter.getData();
		const safe = (s) => (s || "").replace(/[^a-zA-Z0-9_\- ]/g, "").trim();
		const namePart = safe(data.model?.name) || "model-info";
		const versionPart = safe(data.model?.version);
		const baseName = versionPart ? namePart + " - " + versionPart : namePart;
		const zipName =
			"Info - " + baseName + " - " + formatLocalDateTimeForZipName(new Date()) + ".zip";
		downloadBlob(zipBlob, zipName);
		setStatus("Done");
	} catch (e) {
		setStatus(runDownloadErrorLabel(e));
	} finally {
		if (btn) {
			btn.disabled = false;
			btn.classList.remove("hidden");
		}
	}
}

// --- Embedded download panel ---
const CMIS_PANEL_CSS = "#cmis-panel{width:100%}#cmis-panel-toggle{display:flex;align-items:center;justify-content:center;width:100%;height:36px;padding:0 10px;border:none;border-radius:var(--mantine-radius-sm,4px);appearance:none;background:var(--mantine-color-gray-filled,#868e96);box-shadow:none;color:var(--mantine-color-white,#fff);font-family:inherit;font-size:14px;font-weight:600;line-height:1;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent}#cmis-panel-toggle:hover{background:var(--mantine-color-gray-filled-hover,#737373)}#cmis-panel-toggle:active{background:var(--mantine-color-gray-filled,#868e96)}#cmis-panel-drawer{--br-m:12px;--br-full:9999px;--fs-s1:12px;--fs-m:14px;--sp-s4:2px;--sp-s2:6px;--sp-s1:8px;--sp-m:12px;--bg-float:oklch(100% 0 0);--bg-inner2:oklch(95% 0 0);--bg-btn:oklch(100% 0 0);--bg-btn-h:color-mix(in oklch, var(--bg-btn), black 3%);--bg-btn-a:color-mix(in oklch, var(--bg-btn), black 3%);--press-shift:1px;--bs-rim:0 0 0 1px oklch(0% 0 0 / 0.13);--bs-d-hard-s2:0 1px 1px 0px oklch(0% 0 0 / 0.2);--bs-d-hard-s1:0 2px 0 0 oklch(0% 0 0 / 0.14);--bs-d-soft-m:0 3px 3px 0px oklch(0% 0 0 / 0.1);--bs-d-soft-l1:0 8px 48px 0 oklch(0% 0 0 / 0.36);--bsc-panel-top:var(--bs-rim);--bsc-btn:var(--bs-rim),var(--bs-d-hard-s1);--bsc-btn-a:inset var(--bs-rim),inset var(--bs-d-soft-m),inset var(--bs-d-hard-s2);--bsc-float:var(--bs-d-hard-s1),var(--bs-d-soft-l1);--text:oklch(0% 0 0 / 0.92);--text-muted:oklch(0% 0 0 / 0.32);--divider:oklch(0% 0 0 / 0.08);display:flex;flex-direction:column;gap:var(--sp-s1);position:fixed;z-index:10000;padding:var(--sp-m);border-radius:var(--br-m);background:var(--bg-float);background-clip:padding-box;box-shadow:var(--bsc-float);corner-shape:superellipse(1.2);opacity:0;visibility:hidden;color:var(--text);font-family:\"Fira Sans Condensed\",\"Lucida Grande\",\"Segoe UI\",sans-serif;font-size:var(--fs-m);overflow-wrap:anywhere;-webkit-font-smoothing:antialiased;pointer-events:none;transition:opacity 60ms,visibility 0s linear 60ms}#cmis-panel-drawer:after{position:absolute;inset:0;z-index:1;border-radius:inherit;box-shadow:var(--bsc-panel-top);content:\"\";pointer-events:none}#cmis-panel-drawer.is-dark{--bg-float:linear-gradient(oklch(23% 0.05 260), oklch(20% 0.05 260));--bg-inner2:oklch(27% 0.05 260);--bg-btn:oklch(5% 0.05 260);--bg-btn-h:color-mix(in oklch, var(--bg-btn), white 14%);--bg-btn-a:color-mix(in oklch, var(--bg-btn), white 5%);--bs-rim:0 0 0 1px oklch(100% 0 0 / 0.05);--bs-l-hard-s1:0 1px 0 0 oklch(100% 0 0 / 0.12);--bs-l-r-hard-s1:0 -1px 0 0 oklch(100% 0 0 / 0.12);--bs-d-soft-m:0 2px 2px 0 oklch(0% 0 0 / 0.25);--bs-d-soft-l1:0 8px 48px 0 oklch(0% 0 0 / 0.95);--bsc-panel-top:inset var(--bs-l-hard-s1),inset var(--bs-rim);--bsc-btn:var(--bs-l-r-hard-s1),var(--bs-d-soft-m);--bsc-btn-a:var(--bs-l-hard-s1);--bsc-float:var(--bs-d-soft-l1);--text:oklch(100% 0 0 / 0.7);--text-muted:oklch(100% 0 0 / 0.2);--divider:oklch(100% 0 0 / 0.12)}#cmis-panel-drawer.is-open{opacity:1;visibility:visible;pointer-events:auto;transition:opacity 60ms}#cmis-panel-drawer,#cmis-panel-drawer *{box-sizing:border-box}#cmis-panel-drawer .hidden{display:none!important}#cmis-panel-drawer .cmis-switch{position:relative;flex:0 0 152px;cursor:pointer;user-select:none}#cmis-panel-drawer .cmis-switch>input{position:absolute;width:1px;height:1px;margin:0;opacity:0}#cmis-panel-drawer .cmis-sw{display:flex;align-items:stretch;position:relative;width:100%;border-radius:var(--br-full);background:var(--bg-inner2)}#cmis-panel-drawer .cmis-sw:before{position:absolute;inset:0 auto 0 0;z-index:0;width:50%;border-radius:var(--br-full);background:var(--bg-btn);box-shadow:var(--bsc-btn);corner-shape:round;content:\"\";transition:transform 60ms}#cmis-panel-drawer .cmis-switch:hover .cmis-sw:before{background:var(--bg-btn-h)}#cmis-panel-drawer .cmis-switch:has(input:checked) .cmis-sw:before{transform:translateX(100%)}#cmis-panel-drawer .cmis-switch.is-invert:has(input:checked) .cmis-sw:before{transform:translateX(0)}#cmis-panel-drawer .cmis-switch.is-invert:has(input:not(:checked)) .cmis-sw:before{transform:translateX(100%)}#cmis-panel-drawer .cmis-sw>span{display:flex;flex:1;align-items:center;justify-content:center;position:relative;z-index:1;padding:var(--sp-s4) var(--sp-s1);color:var(--text-muted);font-size:var(--fs-m);font-weight:500}#cmis-panel-drawer .cmis-switch.is-invert:has(input:checked) .cmis-sw>span:first-child,#cmis-panel-drawer .cmis-switch.is-invert:has(input:not(:checked)) .cmis-sw>span:last-child,#cmis-panel-drawer .cmis-switch:not(.is-invert):has(input:checked) .cmis-sw>span:last-child,#cmis-panel-drawer .cmis-switch:not(.is-invert):has(input:not(:checked)) .cmis-sw>span:first-child{color:var(--text)}#cmis-panel-drawer .cmis-btn{display:inline-flex;align-items:center;justify-content:center;padding:var(--sp-s4) var(--sp-m);border:0;border-radius:var(--br-full);appearance:none;background:var(--bg-btn);box-shadow:var(--bsc-btn);corner-shape:round;color:inherit;font-family:inherit;font-size:var(--fs-m);cursor:pointer;touch-action:manipulation;user-select:none;-webkit-tap-highlight-color:transparent}#cmis-panel-drawer .cmis-btn:hover:not(:disabled){background:var(--bg-btn-h)}#cmis-panel-drawer .cmis-btn:active:not(:disabled){background:var(--bg-btn-a);box-shadow:var(--bsc-btn-a);transform:translateY(var(--press-shift))}#cmis-panel-drawer h2{margin:0;font-size:var(--fs-m);font-weight:500}#cmis-iq,#cmis-md{display:flex;flex-direction:column;gap:var(--sp-s2)}#cmis-md,#cmis-panel-actions{padding-top:var(--sp-m);border-top:1px solid var(--divider)}#cmis-iq-head,#cmis-md-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:var(--sp-s2)}#cmis-iq-h,#cmis-md-h{margin:0;color:var(--text-muted);font-size:var(--fs-s1);font-weight:400}#cmis-iq-h strong,#cmis-md-h strong{font-weight:500}#cmis-panel-actions{display:flex;flex-direction:column;align-items:center;gap:var(--sp-s2)}#cmis-status{display:flex;align-items:center;justify-content:center;text-align:center}";
const CMIS_PANEL_HTML = "<div id=\"cmis-panel\"><button type=\"button\" id=\"cmis-panel-toggle\" aria-haspopup=\"dialog\" aria-expanded=\"false\" aria-controls=\"cmis-panel-drawer\">Model Info Saver</button></div><div id=\"cmis-panel-drawer\"><div id=\"cmis-iq\"><div id=\"cmis-iq-head\"><h2>Media quality</h2><label class=\"cmis-switch\" data-pref=\"cmis_pref_full_media\" aria-label=\"Media quality: Standard or Full\"><input type=\"checkbox\"> <span class=\"cmis-sw\"><span>Standard</span><span>Full</span></span></label></div><p id=\"cmis-iq-h\"><strong>Full</strong> media can be heavy on Civitai servers for sequential model info downloads, and will increase ZIP sizes. Prefer <strong>Standard</strong> for routine archiving.</p></div><div id=\"cmis-md\" class=\"hidden\"><div id=\"cmis-md-head\"><h2>Media sources</h2><label class=\"cmis-switch is-invert\" data-pref=\"cmis_pref_this_site\" aria-label=\"Gallery media sources: this site only or merge both domains\"><input type=\"checkbox\"> <span class=\"cmis-sw\"><span>This site</span><span>Both</span></span></label></div><p id=\"cmis-md-h\"><strong>This site:</strong> Only the preview media you see here on civitai.red.<br><strong>Both:</strong> Pulls possible additional media from the civitai.com preview carousel.</p></div><div id=\"cmis-panel-actions\"><div id=\"cmis-status\" class=\"hidden\"></div><button type=\"button\" id=\"cmis-download\" class=\"cmis-btn\">Download Model Info</button></div></div>";

function syncDockTheme() {
	if (!cmisUI) return;
	const el = document.documentElement;
	const scheme = el.getAttribute("data-mantine-color-scheme");
	let dark;
	if (scheme === "dark" || scheme === "light") dark = scheme === "dark";
	else dark = getComputedStyle(el).colorScheme === "dark";
	cmisUI.drawer.classList.toggle("is-dark", dark);
}

function bindDockPrefs(root) {
	root.querySelectorAll("[data-pref]").forEach((el) => {
		const input = el.querySelector("input[type=checkbox]");
		if (!input) return;
		const key = el.dataset.pref;
		input.checked = readBoolPref(key, false);
		input.addEventListener("change", () => writeBoolPref(key, input.checked));
	});
}

let cmisUI = null;

function checkPanel() {
	if (!getModelIdFromUrl()) return;
	const share = document.querySelector('button[aria-label="Share"]');
	const actionRow = share && share.closest(".flex.gap-2");
	const row =
		actionRow && actionRow.querySelector('button[aria-label="Report"]')
			? actionRow
			: null;
	if (!row) return;
	if (cmisUI) {
		if (cmisUI.wrap.previousElementSibling !== row) row.after(cmisUI.wrap);
		cmisUI.wrap.style.display = "";
		cmisUI.drawer.style.display = "";
		syncDockTheme();
		if (cmisUI.drawer.classList.contains("is-open")) cmisUI.place();
		return;
	}

	if (!document.getElementById("cmis-font")) {
		const font = document.createElement("link");
		font.id = "cmis-font";
		font.rel = "stylesheet";
		font.href =
			"https://fonts.googleapis.com/css2?family=Fira+Sans+Condensed:ital,wght@0,400;0,500;1,400&display=swap";
		document.head.appendChild(font);
	}
	if (!document.getElementById("cmis-style")) {
		const style = document.createElement("style");
		style.id = "cmis-style";
		style.textContent = CMIS_PANEL_CSS;
		document.head.appendChild(style);
	}

	const box = document.createElement("div");
	box.innerHTML = CMIS_PANEL_HTML;
	const wrap = box.querySelector("#cmis-panel");
	const panelDrawer = box.querySelector("#cmis-panel-drawer");
	const toggle = wrap.querySelector("#cmis-panel-toggle");
	if (isCivitaiRedHost()) {
		panelDrawer.querySelector("#cmis-md").classList.remove("hidden");
	}
	bindDockPrefs(panelDrawer);
	panelDrawer
		.querySelector("#cmis-download")
		.addEventListener("click", runDownload);
	function placeDrawer() {
		const r = toggle.getBoundingClientRect();
		panelDrawer.style.left = r.left + "px";
		panelDrawer.style.top = r.bottom + 8 + "px";
		panelDrawer.style.width = r.width + "px";
	}
	function setExpanded(e) {
		if (e) placeDrawer();
		panelDrawer.classList.toggle("is-open", e);
		toggle.setAttribute("aria-expanded", String(e));
	}
	setExpanded(false);
	function eventInPanel(ev) {
		const path = ev.composedPath();
		return path.includes(wrap) || path.includes(panelDrawer);
	}
	toggle.addEventListener("click", () => {
		setExpanded(!panelDrawer.classList.contains("is-open"));
	});
	document.addEventListener("pointerdown", (ev) => {
		if (panelDrawer.classList.contains("is-open") && !eventInPanel(ev))
			setExpanded(false);
	});
	const placeDrawerIfOpen = () => {
		if (panelDrawer.classList.contains("is-open")) placeDrawer();
	};
	window.addEventListener("scroll", placeDrawerIfOpen, true);
	window.addEventListener("resize", placeDrawerIfOpen);

	document.body.appendChild(panelDrawer);
	row.after(wrap);
	cmisUI = { wrap, drawer: panelDrawer, place: placeDrawer, setExpanded };
	syncDockTheme();
}

function syncPanelForRoute() {
	if (getModelIdFromUrl()) checkPanel();
	else {
		if (!cmisUI) return;
		cmisUI.setExpanded(false);
		cmisUI.wrap.style.display = "none";
		cmisUI.drawer.style.display = "none";
	}
}

function installRouteWatcher() {
	const syncSoon = () => setTimeout(syncPanelForRoute, 0);
	function patchHistory(method) {
		const orig = history[method];
		history[method] = function () {
			const result = orig.apply(this, arguments);
			syncSoon();
			return result;
		};
	}
	patchHistory("pushState");
	patchHistory("replaceState");
	window.addEventListener("popstate", syncSoon);
	let frame = 0;
	new MutationObserver(() => {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			syncPanelForRoute();
		});
	}).observe(document.documentElement, { childList: true, subtree: true });
	new MutationObserver(syncDockTheme).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["class", "data-mantine-color-scheme", "style"],
	});
}

installRouteWatcher();
// iOS Safari only applies :active on tap when a touchstart listener exists.
document.addEventListener("touchstart", () => {}, { passive: true });
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", syncPanelForRoute);
} else {
	syncPanelForRoute();
}
})();
