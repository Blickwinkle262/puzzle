import fs from "node:fs";
import { createStoryLevelService } from "./storyLevelService.js";

export function createStoryCatalogService(options = {}) {
  const {
    db,
    onWarning,
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

  const emitWarning = typeof onWarning === "function" ? onWarning : null;

  function warnCatalogQueryError(scope, error, context = {}) {
    if (!emitWarning) {
      return;
    }

    emitWarning("story-catalog-service.query-failed", {
      scope,
      ...context,
      error,
    });
  }

  const DEFAULT_UNASSIGNED_BOOK_ID = "unassigned";
  const DEFAULT_UNASSIGNED_BOOK_TITLE = "未归档书籍";
  const DEFAULT_FALLBACK_BOOK_TITLE_KEYWORD = "聊斋";

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

  function normalizeLongText(value, limit = 4000) {
    if (typeof value !== "string") {
      return "";
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return "";
    }
    return trimmed.slice(0, limit);
  }

  function normalizeOverviewParagraphs(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter((item) => item.length > 0)
      .slice(0, 24);
  }

  function parseOverviewParagraphsJson(value) {
    if (typeof value !== "string" || !value.trim()) {
      return [];
    }

    let parsed = [];
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }

    return normalizeOverviewParagraphs(parsed);
  }

  function listStoryMetaOverridesById() {
    const map = new Map();
    try {
      const rows = db
        .prepare(
          `
            SELECT
              story_id,
              book_id,
              book_title,
              description,
              story_overview_title,
              story_overview_paragraphs_json,
              updated_by_user_id,
              created_at,
              updated_at
            FROM story_meta_overrides
          `,
        )
        .all();

      for (const row of rows) {
        const storyId = normalizeShortText(row?.story_id);
        if (!storyId) {
          continue;
        }

        map.set(storyId, {
          story_id: storyId,
          book_id: normalizeStoryBookId(row?.book_id),
          book_title: normalizeShortText(row?.book_title),
          description: typeof row?.description === "string" ? row.description : "",
          story_overview_title: typeof row?.story_overview_title === "string" ? row.story_overview_title : "",
          story_overview_paragraphs: parseOverviewParagraphsJson(row?.story_overview_paragraphs_json),
          updated_by_user_id: Number(row?.updated_by_user_id || 0) || null,
          created_at: row?.created_at ? String(row.created_at) : null,
          updated_at: row?.updated_at ? String(row.updated_at) : null,
        });
      }
    } catch (error) {
      warnCatalogQueryError("listStoryMetaOverridesById", error);
      return new Map();
    }

    return map;
  }

  function getStoryMetaOverrideById(storyId) {
    const normalizedStoryId = normalizeShortText(storyId);
    if (!normalizedStoryId) {
      return null;
    }

    const map = listStoryMetaOverridesById();
    return map.get(normalizedStoryId) || null;
  }

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
    const overridesById = listStoryMetaOverridesById();

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

      const storyOverride = overridesById.get(id) || null;

      const storyTitle = typeof item.title === "string" ? item.title : "";
      const storyBookTitle = normalizeShortText(storyOverride?.book_title || item.book_title);
      const storyBookId = normalizeStoryBookId(storyOverride?.book_id || item.book_id);
      const storyDescription = storyOverride
        ? normalizeLongText(storyOverride.description)
        : normalizeLongText(item.description);

      stories.push({
        id,
        title: storyTitle,
        description: storyDescription,
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
      : { book_id: "", book_title: "" };

    const finalBookTitle = explicitBookTitle
      || normalizeShortText(generatedBookMeta?.book_title)
      || normalizeShortText(fallbackMeta.book_title);

    const finalBookId = explicitBookId
      || normalizeStoryBookId(generatedBookMeta?.book_id)
      || normalizeStoryBookId(fallbackMeta.book_id);

    return {
      book_id: finalBookId || DEFAULT_UNASSIGNED_BOOK_ID,
      book_title: finalBookTitle || DEFAULT_UNASSIGNED_BOOK_TITLE,
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
        book_id: normalizeStoryBookId(row?.book_id) || DEFAULT_UNASSIGNED_BOOK_ID,
        book_title: normalizeShortText(row?.book_title) || DEFAULT_UNASSIGNED_BOOK_TITLE,
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
        book_id: normalizeStoryBookId(bookMeta.book_id || row.book_id) || DEFAULT_UNASSIGNED_BOOK_ID,
        book_title: normalizeShortText(bookMeta.book_title) || DEFAULT_UNASSIGNED_BOOK_TITLE,
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
    } catch (error) {
      warnCatalogQueryError("listStoryBookLinksFromBooksDb", error);
      return [];
    }
  }

  function resolveDefaultStoryBookMeta() {
    const preferredBookMeta = findPreferredDefaultBookMeta();
    if (preferredBookMeta) {
      return preferredBookMeta;
    }

    return {
      book_id: DEFAULT_UNASSIGNED_BOOK_ID,
      book_title: DEFAULT_UNASSIGNED_BOOK_TITLE,
    };
  }

  function findPreferredDefaultBookMeta() {
    try {
      const booksDatabase = getBooksDbOrThrow();
      const keywordLike = `%${DEFAULT_FALLBACK_BOOK_TITLE_KEYWORD}%`;
      const sourceLike = "%liaozhai%";
      const row = booksDatabase
        .prepare(
          `
            SELECT id, title
            FROM books
            WHERE title LIKE ? OR source_path LIKE ?
            ORDER BY CASE WHEN title LIKE ? THEN 0 ELSE 1 END, id ASC
            LIMIT 1
          `,
        )
        .get(keywordLike, sourceLike, keywordLike);

      if (!row) {
        return null;
      }

      const bookId = normalizeStoryBookId(row.id);
      const bookTitle = normalizeShortText(row.title);
      if (!bookId || !bookTitle) {
        return null;
      }

      return {
        book_id: bookId,
        book_title: bookTitle,
      };
    } catch {
      return null;
    }
  }

  function getBookMetaById(bookId) {
    const normalizedBookId = normalizePositiveInteger(bookId);
    if (!normalizedBookId) {
      return {
        book_id: DEFAULT_UNASSIGNED_BOOK_ID,
        book_title: DEFAULT_UNASSIGNED_BOOK_TITLE,
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
      book_title: DEFAULT_UNASSIGNED_BOOK_TITLE,
    };
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

  function listBooksForNavigation() {
    try {
      const booksDatabase = getBooksDbOrThrow();
      const rows = booksDatabase
        .prepare(
          `
            SELECT
              b.id AS id,
              b.title AS title,
              COUNT(c.id) AS chapter_count,
              COALESCE(b.updated_at, b.created_at) AS updated_at
            FROM books b
            LEFT JOIN chapters c ON c.book_id = b.id
            GROUP BY b.id
            ORDER BY COALESCE(b.updated_at, b.created_at) DESC, b.id DESC
          `,
        )
        .all();

      return rows.map((row) => ({
        book_id: normalizeStoryBookId(row.id) || DEFAULT_UNASSIGNED_BOOK_ID,
        book_title: normalizeShortText(row.title) || DEFAULT_UNASSIGNED_BOOK_TITLE,
        chapter_count: Math.max(0, Number(row.chapter_count || 0)),
        updated_at: String(row.updated_at || ""),
      }));
    } catch {
      return [];
    }
  }

  function buildAdminStoryMetaSnapshot(storyId) {
    const normalizedStoryId = normalizeShortText(storyId);
    if (!normalizedStoryId) {
      return null;
    }

    const catalog = loadStoryCatalog();
    const entry = catalog.stories.find((item) => item.id === normalizedStoryId);
    if (!entry) {
      return null;
    }

    const story = loadStoryById(normalizedStoryId, catalog);
    if (!story) {
      return null;
    }

    const generatedStoryBookMap = buildGeneratedStoryBookMap();
    const defaultBookMeta = resolveDefaultStoryBookMeta();
    const bookMeta = resolveStoryBookMeta(entry, story, generatedStoryBookMap, defaultBookMeta);
    const books = listBooksForNavigation().map((item) => ({
      book_id: String(item.book_id || ""),
      book_title: String(item.book_title || ""),
      chapter_count: Math.max(0, Number(item.chapter_count || 0)),
    }));

    const storyOverride = getStoryMetaOverrideById(normalizedStoryId);

    return {
      story: {
        id: story.id,
        title: story.title,
        description: story.description,
        book_id: bookMeta.book_id,
        book_title: bookMeta.book_title,
        story_overview_title: String(story.story_overview_title || ""),
        story_overview_paragraphs: Array.isArray(story.story_overview_paragraphs)
          ? story.story_overview_paragraphs.filter((item) => typeof item === "string")
          : [],
        has_override: Boolean(storyOverride),
      },
      books,
    };
  }

  function saveAdminStoryMetaOverride(storyId, payload, actorUserId) {
    const normalizedStoryId = normalizeShortText(storyId);
    if (!normalizedStoryId) {
      throw new Error("storyId 不能为空");
    }

    const snapshot = buildAdminStoryMetaSnapshot(normalizedStoryId);
    if (!snapshot) {
      throw new Error("故事不存在");
    }

    const availableBooks = listBooksForNavigation();
    const requestedBookId = normalizeStoryBookId(payload?.book_id);
    const currentBookId = normalizeStoryBookId(snapshot.story.book_id);
    const nextBookId = requestedBookId || currentBookId;

    let nextBookTitle = "";
    const matchedBook = availableBooks.find((item) => normalizeStoryBookId(item.book_id) === nextBookId) || null;
    if (matchedBook) {
      nextBookTitle = normalizeShortText(matchedBook.book_title);
    } else if (nextBookId === DEFAULT_UNASSIGNED_BOOK_ID) {
      nextBookTitle = DEFAULT_UNASSIGNED_BOOK_TITLE;
    } else {
      throw new Error("book_id 不存在，请重新选择所属书目");
    }

    const nextDescription = normalizeLongText(payload?.description, 4000);
    const nextOverviewTitle = normalizeLongText(payload?.story_overview_title, 120);
    const nextOverviewParagraphs = normalizeOverviewParagraphs(payload?.story_overview_paragraphs);
    const now = new Date().toISOString();
    const normalizedActorUserId = normalizePositiveInteger(actorUserId) || null;

    db.prepare(
      `
        INSERT INTO story_meta_overrides (
          story_id,
          book_id,
          book_title,
          description,
          story_overview_title,
          story_overview_paragraphs_json,
          updated_by_user_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(story_id) DO UPDATE SET
          book_id = excluded.book_id,
          book_title = excluded.book_title,
          description = excluded.description,
          story_overview_title = excluded.story_overview_title,
          story_overview_paragraphs_json = excluded.story_overview_paragraphs_json,
          updated_by_user_id = excluded.updated_by_user_id,
          updated_at = excluded.updated_at
      `,
    ).run(
      normalizedStoryId,
      nextBookId,
      nextBookTitle,
      nextDescription,
      nextOverviewTitle,
      JSON.stringify(nextOverviewParagraphs),
      normalizedActorUserId,
      now,
      now,
    );

    return buildAdminStoryMetaSnapshot(normalizedStoryId);
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

    const storyOverride = getStoryMetaOverrideById(entry.id);
    const storyOverviewParagraphs = storyOverride
      ? normalizeOverviewParagraphs(storyOverride.story_overview_paragraphs)
      : (Array.isArray(payload.story_overview_paragraphs)
        ? payload.story_overview_paragraphs.filter((item) => typeof item === "string")
        : []);
    const storyOverviewTitle = storyOverride
      ? normalizeLongText(storyOverride.story_overview_title, 120)
      : String(payload.story_overview_title || "");
    const storyDescription = storyOverride
      ? normalizeLongText(storyOverride.description, 4000)
      : normalizeLongText(payload.description || entry.description, 4000);

    return {
      id: entry.id,
      title: payload.title || entry.title || entry.id,
      description: storyDescription,
      cover,
      cover_missing: !cover,
      story_overview_title: storyOverviewTitle,
      story_overview_paragraphs: storyOverviewParagraphs,
      default_bgm: normalizeAssetPath(entry.manifest, payload.default_bgm),
      levels,
    };
  }

  return {
    buildGeneratedStoryBookMap,
    listBooksForNavigation,
    buildAdminStoryMetaSnapshot,
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
    saveAdminStoryMetaOverride,
  };
}
