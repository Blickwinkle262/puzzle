import fs from "node:fs";
import { createStoryLevelService } from "./storyLevelService.js";

export function createStoryCatalogService(options = {}) {
  const {
    db,
    storyIndexFile,
    storyPublicPrefix,
    defaultTimerPolicy,
    resolveStoryAssetFsPath,
    doesAssetExist,
    normalizeShortText,
    normalizePositiveInteger,
    normalizePositiveNumber,
    normalizeContentVersion,
    normalizeLegacyIds,
    safeParseJsonObject,
    getBooksDbOrThrow,
  } = options;

  const {
    getLevelOverrideMap,
    loadTimerPolicy,
    normalizeAssetPath,
    normalizeDifficulty,
    normalizeLevel,
    readJson,
    resolveManifestFsPath,
  } = createStoryLevelService({
    db,
    storyPublicPrefix,
    defaultTimerPolicy,
    resolveStoryAssetFsPath,
    doesAssetExist,
    normalizePositiveInteger,
    normalizePositiveNumber,
    normalizeContentVersion,
    normalizeLegacyIds,
    safeParseJsonObject,
  });

  function loadStoryCatalog() {
    if (!fs.existsSync(storyIndexFile)) {
      throw new Error(`未找到故事索引文件: ${storyIndexFile}`);
    }

    let payload;
    try {
      payload = readJson(storyIndexFile);
    } catch {
      throw new Error("故事索引 JSON 解析失败");
    }

    if (!payload || !Array.isArray(payload.stories)) {
      throw new Error("故事索引格式不合法");
    }

    const idSet = new Set();
    const stories = [];

    for (const item of payload.stories) {
      if (!item || typeof item !== "object") {
        continue;
      }

      if (item.enabled === false) {
        continue;
      }

      const id = String(item.id || "").trim();
      const manifest = typeof item.manifest === "string" ? item.manifest.trim() : "";

      if (!id || !manifest) {
        throw new Error("故事索引中的 id/manifest 不能为空");
      }

      if (idSet.has(id)) {
        throw new Error(`故事索引中存在重复 id: ${id}`);
      }
      idSet.add(id);

      resolveManifestFsPath(manifest);

      const storyTitle = typeof item.title === "string" ? item.title : "";
      const storyBookTitle = normalizeShortText(item.book_title);
      const storyBookId = normalizeStoryBookId(item.book_id);

      stories.push({
        id,
        title: storyTitle,
        description: typeof item.description === "string" ? item.description : "",
        cover: typeof item.cover === "string" ? item.cover : "",
        manifest,
        book_id: storyBookId,
        book_title: storyBookTitle,
        order: Number.isFinite(item.order) ? Number(item.order) : Number.MAX_SAFE_INTEGER,
      });
    }

    return {
      stories: stories.sort((first, second) => {
        if (first.order !== second.order) {
          return first.order - second.order;
        }
        return first.id.localeCompare(second.id);
      }),
    };
  }

  function resolveStoryBookMeta(entry, story, generatedStoryBookMap, defaultBookMeta) {
    const entryBookTitle = normalizeShortText(entry?.book_title);
    const storyBookTitle = normalizeShortText(story?.book_title);
    const explicitBookTitle = entryBookTitle || storyBookTitle;

    const entryBookId = normalizeStoryBookId(entry?.book_id);
    const storyBookId = normalizeStoryBookId(story?.book_id);
    const explicitBookId = entryBookId || storyBookId;

    const storyId = normalizeShortText(story?.id || entry?.id);
    const generatedBookMeta = storyId && generatedStoryBookMap instanceof Map
      ? generatedStoryBookMap.get(storyId)
      : null;

    const fallbackMeta = defaultBookMeta && typeof defaultBookMeta === "object"
      ? defaultBookMeta
      : { book_id: "liaozhai", book_title: "聊斋志异" };

    const finalBookTitle = explicitBookTitle
      || normalizeShortText(generatedBookMeta?.book_title)
      || normalizeShortText(fallbackMeta.book_title)
      || "聊斋志异";

    const finalBookId = explicitBookId
      || normalizeStoryBookId(generatedBookMeta?.book_id)
      || normalizeStoryBookId(fallbackMeta.book_id)
      || "liaozhai";

    return {
      book_id: finalBookId,
      book_title: finalBookTitle,
    };
  }

  function buildGeneratedStoryBookMap() {
    const map = new Map();

    const usageRows = listStoryBookLinksFromBooksDb();
    for (const row of usageRows) {
      const storyId = normalizeShortText(row?.story_id);
      if (!storyId || map.has(storyId)) {
        continue;
      }

      map.set(storyId, {
        book_id: normalizeStoryBookId(row?.book_id) || "liaozhai",
        book_title: normalizeShortText(row?.book_title) || "聊斋志异",
      });
    }

    let metaRows = [];
    try {
      metaRows = db
        .prepare(
          `
        SELECT result_story_id, book_id
        FROM generation_job_meta
        WHERE COALESCE(result_story_id, '') <> ''
          AND book_id IS NOT NULL
        ORDER BY COALESCE(updated_at, created_at) DESC
      `,
        )
        .all();
    } catch {
      metaRows = [];
    }

    for (const row of metaRows) {
      const storyId = normalizeShortText(row.result_story_id);
      if (!storyId || map.has(storyId)) {
        continue;
      }

      const bookMeta = getBookMetaById(row.book_id);
      map.set(storyId, {
        book_id: normalizeStoryBookId(bookMeta.book_id || row.book_id) || "liaozhai",
        book_title: normalizeShortText(bookMeta.book_title) || "聊斋志异",
      });
    }

    return map;
  }

  function listStoryBookLinksFromBooksDb() {
    try {
      const booksDatabase = getBooksDbOrThrow();
      return booksDatabase
        .prepare(
          `
        SELECT
          cu.generated_story_id AS story_id,
          c.book_id AS book_id,
          b.title AS book_title,
          cu.updated_at
        FROM chapter_usage cu
        JOIN chapters c ON c.id = cu.chapter_id
        JOIN books b ON b.id = c.book_id
        WHERE cu.usage_type = 'puzzle_story'
          AND cu.status = 'succeeded'
          AND COALESCE(cu.generated_story_id, '') <> ''
        ORDER BY COALESCE(cu.updated_at, cu.created_at) DESC, cu.id DESC
      `,
        )
        .all();
    } catch {
      return [];
    }
  }

  function resolveDefaultStoryBookMeta(generatedStoryBookMap) {
    if (generatedStoryBookMap instanceof Map && generatedStoryBookMap.size > 0) {
      const first = generatedStoryBookMap.values().next().value;
      if (first && typeof first === "object") {
        return {
          book_id: normalizeStoryBookId(first.book_id) || "liaozhai",
          book_title: normalizeShortText(first.book_title) || "聊斋志异",
        };
      }
    }

    const preferred = findPreferredBookMeta();
    if (preferred) {
      return preferred;
    }

    return {
      book_id: "liaozhai",
      book_title: "聊斋志异",
    };
  }

  function getBookMetaById(bookId) {
    const normalizedBookId = normalizePositiveInteger(bookId);
    if (!normalizedBookId) {
      return {
        book_id: "liaozhai",
        book_title: "聊斋志异",
      };
    }

    try {
      const booksDatabase = getBooksDbOrThrow();
      const row = booksDatabase
        .prepare("SELECT id, title FROM books WHERE id = ? LIMIT 1")
        .get(normalizedBookId);

      if (row) {
        return {
          book_id: String(row.id),
          book_title: String(row.title || ""),
        };
      }
    } catch {
      // ignore lookup errors and fallback
    }

    return {
      book_id: String(normalizedBookId),
      book_title: "聊斋志异",
    };
  }

  function findPreferredBookMeta() {
    try {
      const booksDatabase = getBooksDbOrThrow();
      const preferred = booksDatabase
        .prepare("SELECT id, title FROM books WHERE title LIKE ? ORDER BY id ASC LIMIT 1")
        .get("%聊斋%");

      if (preferred) {
        return {
          book_id: normalizeStoryBookId(preferred.id) || "liaozhai",
          book_title: normalizeShortText(preferred.title) || "聊斋志异",
        };
      }

      const first = booksDatabase.prepare("SELECT id, title FROM books ORDER BY id ASC LIMIT 1").get();
      if (first) {
        return {
          book_id: normalizeStoryBookId(first.id) || "liaozhai",
          book_title: normalizeShortText(first.title) || "聊斋志异",
        };
      }
    } catch {
      return null;
    }

    return null;
  }

  function normalizeStoryBookId(value) {
    if (value === null || value === undefined) {
      return "";
    }

    const normalized = String(value)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    return normalized.slice(0, 48);
  }

  function loadStoryById(storyId, catalog) {
    const activeCatalog = catalog || loadStoryCatalog();
    const entry = activeCatalog.stories.find((item) => item.id === storyId);
    if (!entry) {
      return null;
    }

    const manifestPath = resolveManifestFsPath(entry.manifest);
    const payload = readJson(manifestPath);
    const levelOverrideMap = getLevelOverrideMap(entry.id);
    const timerPolicy = loadTimerPolicy();

    const levelsRaw = Array.isArray(payload.levels) ? payload.levels : [];
    const levels = levelsRaw.map(
      (level, index) => normalizeLevel(entry.manifest, level, index, levelOverrideMap, timerPolicy),
    );

    if (levels.length === 0) {
      throw new Error(`故事 ${storyId} 没有可用关卡`);
    }

    const coverCandidate = normalizeAssetPath(entry.manifest, payload.cover || entry.cover);
    const cover = doesAssetExist(coverCandidate)
      ? coverCandidate
      : levels.find((item) => !item.asset_missing)?.source_image || "";

    return {
      id: entry.id,
      title: payload.title || entry.title || entry.id,
      description: payload.description || entry.description || "",
      cover,
      cover_missing: !cover,
      story_overview_title: payload.story_overview_title || "",
      story_overview_paragraphs: Array.isArray(payload.story_overview_paragraphs)
        ? payload.story_overview_paragraphs.filter((item) => typeof item === "string")
        : [],
      default_bgm: normalizeAssetPath(entry.manifest, payload.default_bgm),
      levels,
    };
  }

  return {
    buildGeneratedStoryBookMap,
    loadStoryById,
    loadStoryCatalog,
    loadTimerPolicy,
    normalizeDifficulty,
    normalizeLevel,
    normalizeStoryBookId,
    readJson,
    resolveDefaultStoryBookMeta,
    resolveManifestFsPath,
    resolveStoryBookMeta,
  };
}
