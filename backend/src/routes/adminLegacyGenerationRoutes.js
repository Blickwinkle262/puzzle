import path from "node:path";

export function registerAdminLegacyGenerationRoutes(app, deps) {
  const {
    LEGACY_GENERATE_STORY_CREATE_ENABLED,
    RESOLVED_BOOK_INGEST_DB_PATH,
    STORY_GENERATOR_INDEX_FILE,
    STORY_GENERATOR_LOG_DIR,
    STORY_GENERATOR_OUTPUT_ROOT,
    STORY_GENERATOR_SUMMARY_DIR,
    asMessage,
    buildGenerationSummaryFileName,
    defaultGenerationRunId,
    enqueueGenerationJob,
    getBooksDbOrThrow,
    getGeneratedChapterMap,
    getGenerationJobByRunId,
    hasGenerationSceneRows,
    listGenerationJobCandidates,
    listGenerationJobs,
    listGenerationScenes,
    materializeChapterTextToFile,
    normalizeBoolean,
    normalizeNonNegativeInteger,
    normalizePositiveInteger,
    normalizePositiveNumber,
    normalizeRunId,
    normalizeShortText,
    normalizeStoryFile,
    normalizeTargetDate,
    readJsonSafe,
    readRunEvents,
    readTailLines,
    requireAdmin,
    requireAuth,
    requireCsrf,
    safeParseJsonObject,
    serializeGenerationSceneAsLegacyCandidate,
    summarizeGenerationCandidates,
    summarizeGenerationScenes,
    summarizeLegacyCandidateCountsFromScenes,
    syncGenerationJobCandidatesFromSummary,
  } = deps;

  app.post("/api/admin/generate-story", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    if (!LEGACY_GENERATE_STORY_CREATE_ENABLED) {
      res.status(410).json({
        message: "旧入口 /api/admin/generate-story 已下线，请改用 /api/runs/:runId/generate-text。",
        code: "legacy_generate_story_disabled",
        migration: {
          since: "2026-03-06",
          create_run: "POST /api/runs/:runId/generate-text",
          list_runs: "GET /api/runs",
          review_run: "GET /api/runs/:runId",
        },
      });
      return;
    }

    const targetDate = normalizeTargetDate(req.body?.target_date);
    if (!targetDate) {
      res.status(400).json({ message: "target_date 必须是 YYYY-MM-DD" });
      return;
    }

    const runId = normalizeRunId(req.body?.run_id) || defaultGenerationRunId();
    const chapterId = normalizePositiveInteger(req.body?.chapter_id);
    if (req.body?.chapter_id !== undefined && !chapterId) {
      res.status(400).json({ message: "chapter_id 必须是正整数" });
      return;
    }

    const inputStoryFile = normalizeStoryFile(req.body?.story_file);
    if (req.body?.story_file && !inputStoryFile) {
      res.status(400).json({ message: "story_file 无效或不存在" });
      return;
    }

    if (chapterId && inputStoryFile) {
      res.status(400).json({ message: "chapter_id 与 story_file 只能二选一" });
      return;
    }

    let storyFile = inputStoryFile;
    let chapterSource = null;
    if (chapterId) {
      try {
        chapterSource = materializeChapterTextToFile(chapterId, runId);
        storyFile = chapterSource.story_file;
      } catch (error) {
        const message = asMessage(error, "读取章节失败");
        const status = message.includes("不存在") ? 404 : 400;
        res.status(status).json({ message });
        return;
      }
    }

    const requestedSceneCount = normalizePositiveInteger(req.body?.scene_count);
    if (req.body?.scene_count !== undefined && (!requestedSceneCount || requestedSceneCount <= 5)) {
      res.status(400).json({ message: "scene_count 必须是大于 5 的正整数" });
      return;
    }

    let candidateScenes = normalizePositiveInteger(req.body?.candidate_scenes);
    let minScenes = normalizePositiveInteger(req.body?.min_scenes);
    let maxScenes = normalizePositiveInteger(req.body?.max_scenes);

    if (requestedSceneCount) {
      maxScenes = requestedSceneCount;
      minScenes = Math.max(6, requestedSceneCount - 2);
      candidateScenes = requestedSceneCount;
    }

    if (maxScenes && minScenes && maxScenes < minScenes) {
      res.status(400).json({ message: "max_scenes 必须 >= min_scenes" });
      return;
    }

    if (candidateScenes && maxScenes && candidateScenes < maxScenes) {
      res.status(400).json({ message: "candidate_scenes 必须 >= max_scenes" });
      return;
    }

    const dryRun = Boolean(req.body?.dry_run);
    const reviewMode = req.body?.review_mode === undefined ? true : normalizeBoolean(req.body?.review_mode);
    const logFile = path.join(STORY_GENERATOR_LOG_DIR, `${runId}.log`);
    const eventLogFile = path.join(STORY_GENERATOR_LOG_DIR, `${runId}.events.jsonl`);
    const summaryPath = path.join(STORY_GENERATOR_SUMMARY_DIR, buildGenerationSummaryFileName(targetDate, runId));

    const payload = {
      run_id: runId,
      target_date: targetDate,
      story_file: storyFile || "",
      dry_run: dryRun,
      review_mode: reviewMode,
      output_root: STORY_GENERATOR_OUTPUT_ROOT,
      index_file: STORY_GENERATOR_INDEX_FILE,
      summary_output_dir: STORY_GENERATOR_SUMMARY_DIR,
      log_file: logFile,
      event_log_file: eventLogFile,
      summary_path: summaryPath,
      story_id: normalizeShortText(req.body?.story_id) || "",
      image_size: normalizeShortText(req.body?.image_size) || "",
      scene_count: requestedSceneCount || null,
      candidate_scenes: candidateScenes,
      min_scenes: minScenes,
      max_scenes: maxScenes,
      concurrency: normalizePositiveInteger(req.body?.concurrency),
      timeout_sec: normalizePositiveNumber(req.body?.timeout_sec),
      poll_seconds: normalizePositiveNumber(req.body?.poll_seconds),
      poll_attempts: normalizePositiveInteger(req.body?.poll_attempts),
      chapter_id: chapterSource?.chapter_id || chapterId || null,
      chapter_title: chapterSource?.chapter_title || "",
      chapter_index: chapterSource?.chapter_index ?? null,
      chapter_char_count: chapterSource?.char_count ?? null,
      book_id: chapterSource?.book_id ?? null,
      book_title: chapterSource?.book_title || "",
    };

    try {
      enqueueGenerationJob({
        runId,
        requestedBy: req.authUser.username,
        targetDate,
        storyFile,
        dryRun,
        payload,
        logFile,
        eventLogFile,
        summaryPath,
      });
    } catch (error) {
      const message = asMessage(error, "创建生成任务失败");
      if (message.includes("UNIQUE") || message.includes("run_id")) {
        res.status(409).json({ message: `run_id 已存在: ${runId}` });
        return;
      }
      res.status(500).json({ message });
      return;
    }

    res.status(202).json({
      ok: true,
      run_id: runId,
      status: "queued",
      target_date: targetDate,
      dry_run: dryRun,
      review_mode: reviewMode,
      log_file: logFile,
      event_log_file: eventLogFile,
      summary_path: summaryPath,
      scene_count: maxScenes || null,
      story_file: storyFile || "",
      chapter: chapterSource
        ? {
            chapter_id: chapterSource.chapter_id,
            chapter_index: chapterSource.chapter_index,
            chapter_title: chapterSource.chapter_title,
            char_count: chapterSource.char_count,
            book_id: chapterSource.book_id,
            book_title: chapterSource.book_title,
          }
        : null,
    });
  });

  app.get("/api/admin/book-chapters", requireAuth, requireAdmin, (req, res) => {
    try {
      const booksDatabase = getBooksDbOrThrow();

      const limit = Math.min(200, normalizePositiveInteger(req.query?.limit) || 50);
      const offset = normalizeNonNegativeInteger(req.query?.offset, 0);
      const minChars = normalizePositiveInteger(req.query?.min_chars);
      const maxChars = normalizePositiveInteger(req.query?.max_chars);
      const includeUsed = normalizeBoolean(req.query?.include_used);
      const includeTocLike = normalizeBoolean(req.query?.include_toc_like);
      const bookId = normalizePositiveInteger(req.query?.book_id);
      const keyword = normalizeShortText(req.query?.keyword);
      const bookTitle = normalizeShortText(req.query?.book_title);

      const where = ["1 = 1"];
      const params = [];

      if (bookId) {
        where.push("b.id = ?");
        params.push(bookId);
      } else if (bookTitle) {
        where.push("b.title LIKE ?");
        params.push(`%${bookTitle}%`);
      }

      if (minChars) {
        where.push("c.char_count >= ?");
        params.push(minChars);
      }

      if (maxChars) {
        where.push("c.char_count <= ?");
        params.push(maxChars);
      }

      if (keyword) {
        where.push("c.chapter_title LIKE ?");
        params.push(`%${keyword}%`);
      }

      if (!includeTocLike) {
        where.push("COALESCE(json_extract(c.meta_json, '$.is_toc_like'), 0) = 0");
      }

      if (!includeUsed) {
        where.push(
          `NOT EXISTS (
            SELECT 1
            FROM chapter_usage su
            WHERE su.chapter_id = c.id
              AND su.usage_type = 'puzzle_story'
              AND su.status = 'succeeded'
          )`,
        );
      }

      const whereClause = where.join(" AND ");

      const totalRow = booksDatabase
        .prepare(
          `
          SELECT COUNT(1) AS total
          FROM chapters c
          JOIN books b ON b.id = c.book_id
          WHERE ${whereClause}
        `,
        )
        .get(...params);

      const rows = booksDatabase
        .prepare(
          `
          SELECT c.id, c.book_id, b.title AS book_title, b.genre,
                 c.chapter_index, c.chapter_title, c.char_count, c.word_count,
                 c.used_count, c.last_used_at, c.meta_json,
                 SUBSTR(REPLACE(REPLACE(c.chapter_text, char(13), ' '), char(10), ' '), 1, 120) AS preview,
                 CASE WHEN EXISTS (
                   SELECT 1
                   FROM chapter_usage su
                   WHERE su.chapter_id = c.id
                     AND su.usage_type = 'puzzle_story'
                     AND su.status = 'succeeded'
                 ) THEN 1 ELSE 0 END AS has_succeeded_story
          FROM chapters c
          JOIN books b ON b.id = c.book_id
          WHERE ${whereClause}
          ORDER BY c.used_count ASC, c.char_count DESC, c.chapter_index ASC
          LIMIT ? OFFSET ?
        `,
        )
        .all(...params, limit, offset);

      const generatedByChapterId = getGeneratedChapterMap(rows.map((item) => Number(item.id)));

      const books = booksDatabase
        .prepare(
          `
          SELECT b.id, b.title, b.author, b.genre, b.source_format,
                 COUNT(c.id) AS chapter_count,
                 COALESCE(MIN(c.char_count), 0) AS min_char_count,
                 COALESCE(MAX(c.char_count), 0) AS max_char_count
          FROM books b
          LEFT JOIN chapters c ON c.book_id = b.id
          GROUP BY b.id
          ORDER BY b.updated_at DESC, b.id DESC
        `,
        )
        .all();

      res.json({
        db_path: RESOLVED_BOOK_INGEST_DB_PATH,
        total: Number(totalRow?.total || 0),
        has_more: Number(totalRow?.total || 0) > offset + rows.length,
        filters: {
          limit,
          offset,
          min_chars: minChars || null,
          max_chars: maxChars || null,
          keyword,
          include_used: includeUsed,
          include_toc_like: includeTocLike,
          book_id: bookId || null,
          book_title: bookTitle,
        },
        books: books.map((item) => ({
          id: Number(item.id),
          title: String(item.title || ""),
          author: String(item.author || ""),
          genre: String(item.genre || ""),
          source_format: String(item.source_format || ""),
          chapter_count: Number(item.chapter_count || 0),
          min_char_count: Number(item.min_char_count || 0),
          max_char_count: Number(item.max_char_count || 0),
        })),
        chapters: rows.map((row) => {
          const chapterId = Number(row.id);
          const generatedMeta = generatedByChapterId.get(chapterId);
          const hasSucceededStory = Boolean(row.has_succeeded_story) || Boolean(generatedMeta);

          return {
            id: chapterId,
            book_id: Number(row.book_id),
            book_title: String(row.book_title || ""),
            genre: String(row.genre || ""),
            chapter_index: Number(row.chapter_index),
            chapter_title: String(row.chapter_title || ""),
            char_count: Number(row.char_count || 0),
            word_count: Number(row.word_count || 0),
            used_count: Number(row.used_count || 0),
            last_used_at: row.last_used_at || null,
            preview: String(row.preview || ""),
            has_succeeded_story: hasSucceededStory,
            generated_story_id: generatedMeta?.story_id || null,
            generated_run_id: generatedMeta?.run_id || null,
            generated_at: generatedMeta?.generated_at || null,
            meta_json: safeParseJsonObject(row.meta_json),
          };
        }),
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取章节列表失败") });
    }
  });

  app.get("/api/admin/generate-story", requireAuth, requireAdmin, (req, res) => {
    try {
      const limit = normalizePositiveInteger(req.query?.limit) || 50;
      const jobs = listGenerationJobs(Math.min(200, limit));
      res.json({ jobs });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取任务列表失败") });
    }
  });

  app.get("/api/admin/generate-story/:runId", requireAuth, requireAdmin, (req, res) => {
    const runId = String(req.params.runId || "").trim();
    if (!runId) {
      res.status(400).json({ message: "run_id 不能为空" });
      return;
    }

    try {
      const job = getGenerationJobByRunId(runId);
      if (!job) {
        res.status(404).json({ message: "run_id 不存在" });
        return;
      }

      const events = readRunEvents(job.event_log_file, runId, 30);
      const logTail = readTailLines(job.log_file, 80);
      let summary = readJsonSafe(job.summary_path);
      let candidates = [];
      let candidateCounts = {
        total: 0,
        success: 0,
        failed: 0,
        pending: 0,
        selected: 0,
        ready_for_publish: 0,
      };

      if (hasGenerationSceneRows(runId)) {
        const scenes = listGenerationScenes(runId, { include_deleted: true });
        const sceneCounts = summarizeGenerationScenes(scenes);
        candidates = scenes.map((scene) => serializeGenerationSceneAsLegacyCandidate(scene));
        candidateCounts = summarizeLegacyCandidateCountsFromScenes(sceneCounts);

        if (!summary || typeof summary !== "object") {
          summary = {
            run_id: runId,
            total_scenes: Math.max(0, candidateCounts.total),
            generated_scenes: Number(sceneCounts.images_success || 0),
            review_mode: true,
            review_status: job.review_status,
          };
        }
      } else {
        if (job.status === "succeeded") {
          syncGenerationJobCandidatesFromSummary(runId, job.summary_path);
        }
        candidates = listGenerationJobCandidates(runId);
        candidateCounts = summarizeGenerationCandidates(candidates);
      }

      res.json({
        ...job,
        events,
        log_tail: logTail,
        summary,
        candidates,
        candidate_counts: candidateCounts,
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取任务详情失败") });
    }
  });
}
