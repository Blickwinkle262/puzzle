import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import Database from "better-sqlite3";

export function registerAdminLegacyGenerationRoutes(app, deps) {
  const {
    BOOK_UPLOADS_DIR,
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
    runBookIngestCommand,
    runBookSummaryCommand,
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

  const activeBookSummaryControllers = new Map();

  function normalizeIngestTaskStatus(value) {
    const status = String(value || "").trim().toLowerCase();
    if (status === "success") {
      return "succeeded";
    }
    if (status === "failed") {
      return "failed";
    }
    if (status === "running") {
      return "running";
    }
    return "queued";
  }

  function serializeIngestRun(row) {
    if (!row || typeof row !== "object") {
      return null;
    }

    return {
      run_id: String(row.run_id || ""),
      status: normalizeIngestTaskStatus(row.status),
      source_path: String(row.source_path || ""),
      source_format: String(row.source_format || ""),
      source_name: path.basename(String(row.source_path || "")),
      started_at: row.started_at ? String(row.started_at) : null,
      finished_at: row.finished_at ? String(row.finished_at) : null,
      created_at: row.created_at ? String(row.created_at) : null,
      total: Number(row.total_chapters || 0),
      inserted: Number(row.inserted_chapters || 0),
      updated: Number(row.updated_chapters || 0),
      skipped: Number(row.skipped_chapters || 0),
      error_message: String(row.error_message || ""),
    };
  }

  function getIngestRunByRunId(runId) {
    const normalizedRunId = normalizeShortText(runId || "");
    if (!normalizedRunId) {
      return null;
    }

    try {
      const booksDb = getBooksDbOrThrow();
      const row = booksDb
        .prepare(
          `
            SELECT
              run_id,
              source_path,
              source_format,
              started_at,
              finished_at,
              status,
              total_chapters,
              inserted_chapters,
              updated_chapters,
              skipped_chapters,
              error_message,
              created_at
            FROM ingest_runs
            WHERE run_id = ?
            LIMIT 1
          `,
        )
        .get(normalizedRunId);
      return serializeIngestRun(row);
    } catch {
      return null;
    }
  }

  function listIngestRuns(limitValue) {
    const limit = Math.min(50, normalizePositiveInteger(limitValue) || 10);

    try {
      const booksDb = getBooksDbOrThrow();
      const rows = booksDb
        .prepare(
          `
            SELECT
              run_id,
              source_path,
              source_format,
              started_at,
              finished_at,
              status,
              total_chapters,
              inserted_chapters,
              updated_chapters,
              skipped_chapters,
              error_message,
              created_at
            FROM ingest_runs
            ORDER BY id DESC
            LIMIT ?
          `,
        )
        .all(limit);

      return rows
        .map((row) => serializeIngestRun(row))
        .filter((item) => item && item.run_id);
    } catch {
      return [];
    }
  }

  function normalizeSummaryTaskStatus(value) {
    const status = String(value || "").trim().toLowerCase();
    if (status === "success") {
      return "succeeded";
    }
    if (status === "failed") {
      return "failed";
    }
    if (status === "running") {
      return "running";
    }
    return "queued";
  }

  function serializeSummaryRun(row) {
    if (!row || typeof row !== "object") {
      return null;
    }

    return {
      run_id: String(row.run_id || ""),
      status: normalizeSummaryTaskStatus(row.status),
      scope_type: String(row.scope_type || "book"),
      scope_id: Number(row.scope_id || 0),
      started_at: row.started_at ? String(row.started_at) : null,
      finished_at: row.finished_at ? String(row.finished_at) : null,
      created_at: row.created_at ? String(row.created_at) : null,
      total: Number(row.total_chapters || 0),
      processed: Number(row.processed_chapters || 0),
      succeeded: Number(row.succeeded_chapters || 0),
      failed: Number(row.failed_chapters || 0),
      skipped: Number(row.skipped_chapters || 0),
      error_message: String(row.error_message || ""),
    };
  }

  function serializeSummaryRunItem(row) {
    if (!row || typeof row !== "object") {
      return null;
    }

    const normalizedStatus = String(row.status || "").trim().toLowerCase();
    const status = normalizedStatus === "failed"
      ? "failed"
      : normalizedStatus === "skipped"
        ? "skipped"
        : "succeeded";

    return {
      chapter_id: Number(row.chapter_id || 0),
      chapter_index: Number(row.chapter_index || 0),
      chapter_title: String(row.chapter_title || ""),
      status,
      source_chars: Number(row.source_chars || 0),
      chunks_count: Number(row.chunks_count || 0),
      error_message: String(row.error_message || ""),
      updated_at: row.updated_at ? String(row.updated_at) : null,
    };
  }

  function getSummaryRunByRunId(runId) {
    const normalizedRunId = normalizeShortText(runId || "");
    if (!normalizedRunId) {
      return null;
    }

    try {
      const booksDb = getBooksDbOrThrow();
      const row = booksDb
        .prepare(
          `
            SELECT
              run_id,
              scope_type,
              scope_id,
              started_at,
              finished_at,
              status,
              total_chapters,
              processed_chapters,
              succeeded_chapters,
              failed_chapters,
              skipped_chapters,
              error_message,
              created_at
            FROM chapter_summary_runs
            WHERE run_id = ?
            LIMIT 1
          `,
        )
        .get(normalizedRunId);
      return serializeSummaryRun(row);
    } catch {
      return null;
    }
  }

  function listSummaryRuns(limitValue) {
    const limit = Math.min(50, normalizePositiveInteger(limitValue) || 10);

    try {
      const booksDb = getBooksDbOrThrow();
      const rows = booksDb
        .prepare(
          `
            SELECT
              run_id,
              scope_type,
              scope_id,
              started_at,
              finished_at,
              status,
              total_chapters,
              processed_chapters,
              succeeded_chapters,
              failed_chapters,
              skipped_chapters,
              error_message,
              created_at
            FROM chapter_summary_runs
            ORDER BY id DESC
            LIMIT ?
          `,
        )
        .all(limit);

      return rows
        .map((row) => serializeSummaryRun(row))
        .filter((item) => item && item.run_id);
    } catch {
      return [];
    }
  }

  function startBookSummaryRunTask({
    runId,
    scopeType,
    scopeId,
    userId,
    force,
    chunkSize,
    summaryMaxChars,
  }) {
    const normalizedScopeType = String(scopeType || "").trim() === "chapter" ? "chapter" : "book";
    const normalizedScopeId = normalizePositiveInteger(scopeId);
    if (!normalizedScopeId) {
      throw new Error("scope_id 必须是正整数");
    }

    const control = {
      pid: 0,
      kill: () => false,
    };
    activeBookSummaryControllers.set(runId, control);

    const commandPromise = runBookSummaryCommand({
      bookId: normalizedScopeType === "book" ? normalizedScopeId : 0,
      chapterId: normalizedScopeType === "chapter" ? normalizedScopeId : 0,
      runId,
      userId,
      force,
      chunkSize,
      summaryMaxChars,
      onSpawn: ({ pid, kill }) => {
        control.pid = Number(pid) || 0;
        control.kill = typeof kill === "function" ? kill : () => false;
      },
    });

    void commandPromise
      .catch((error) => {
        console.error("[book-summary] async task failed", error);
        const normalizedMessage = asMessage(error, "摘要任务执行失败");
        markSummaryRunAsCancelled(runId, `摘要任务异常终止：${normalizedMessage}`);
      })
      .finally(() => {
        activeBookSummaryControllers.delete(runId);
      });
  }

  function markSummaryRunAsCancelled(runId, reason) {
    const normalizedRunId = normalizeShortText(runId || "");
    if (!normalizedRunId) {
      return {
        task: null,
        changes: 0,
        writeError: "run_id 不能为空",
      };
    }

    const message = String(reason || "").trim() || "任务已由管理员取消";
    let changes = 0;
    let writeError = "";
    let booksWriteDb = null;

    try {
      booksWriteDb = new Database(RESOLVED_BOOK_INGEST_DB_PATH, {
        fileMustExist: true,
      });
      booksWriteDb.pragma("busy_timeout = 5000");
      const result = booksWriteDb
        .prepare(
          `
            UPDATE chapter_summary_runs
            SET status = 'failed',
                finished_at = COALESCE(finished_at, datetime('now')),
                error_message = ?
            WHERE run_id = ? AND status IN ('running', 'queued')
          `,
        )
        .run(message, normalizedRunId);
      changes = Number(result?.changes || 0);
    } catch (error) {
      writeError = asMessage(error, "写入取消状态失败");
      console.error("[book-summary] failed to mark cancelled", error);
    } finally {
      if (booksWriteDb) {
        booksWriteDb.close();
      }
    }

    return {
      task: getSummaryRunByRunId(normalizedRunId),
      changes,
      writeError,
    };
  }

  function getBookByBookId(bookId) {
    const normalizedBookId = normalizePositiveInteger(bookId);
    if (!normalizedBookId) {
      return null;
    }

    try {
      const booksDb = getBooksDbOrThrow();
      const row = booksDb
        .prepare(
          `
            SELECT
              b.id,
              b.title,
              b.author,
              b.genre,
              b.language,
              b.source_path,
              b.source_format,
              COUNT(c.id) AS chapter_count
            FROM books b
            LEFT JOIN chapters c ON c.book_id = b.id
            WHERE b.id = ?
            GROUP BY b.id
            LIMIT 1
          `,
        )
        .get(normalizedBookId);
      if (!row) {
        return null;
      }

      return {
        id: Number(row.id),
        title: String(row.title || ""),
        author: String(row.author || ""),
        genre: String(row.genre || ""),
        language: String(row.language || "zh"),
        source_path: String(row.source_path || ""),
        source_format: String(row.source_format || "auto"),
        chapter_count: Number(row.chapter_count || 0),
      };
    } catch {
      return null;
    }
  }

  app.get("/api/admin/books/upload", requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(50, normalizePositiveInteger(req.query?.limit) || 10);
    const tasks = listIngestRuns(limit);
    res.json({
      ok: true,
      db_path: RESOLVED_BOOK_INGEST_DB_PATH,
      limit,
      tasks,
    });
  });

  app.get("/api/admin/books/upload/:runId", requireAuth, requireAdmin, (req, res) => {
    const task = getIngestRunByRunId(req.params?.runId || "");
    if (!task) {
      res.status(404).json({ message: "未找到上传任务", code: "book_ingest_run_not_found" });
      return;
    }

    res.json({
      ok: true,
      db_path: RESOLVED_BOOK_INGEST_DB_PATH,
      task,
    });
  });

  app.post(
    "/api/admin/books/upload",
    requireAuth,
    requireCsrf,
    requireAdmin,
    express.raw({
      type: ["application/octet-stream", "application/epub+zip", "text/plain"],
      limit: "80mb",
    }),
    async (req, res) => {
      const fileNameHeader = req.headers["x-file-name"];
      const headerFileName = Array.isArray(fileNameHeader) ? String(fileNameHeader[0] || "") : String(fileNameHeader || "");
      const rawFileName = normalizeShortText(headerFileName || req.query?.filename || "");
      if (!rawFileName) {
        res.status(400).json({ message: "缺少文件名，请在 x-file-name 头里传入" });
        return;
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        res.status(400).json({ message: "上传内容为空" });
        return;
      }

      const normalizedName = rawFileName
        .replace(/[\\/]+/g, "_")
        .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 120);
      const safeName = normalizedName || `book_${Date.now()}.epub`;

      const requestedFormat = String(req.query?.format || "").trim().toLowerCase();
      const inferredFormat = safeName.toLowerCase().endsWith(".epub") ? "epub" : "txt";
      const sourceFormat = requestedFormat === "epub" || requestedFormat === "txt" ? requestedFormat : inferredFormat;

      const title = normalizeShortText(req.query?.title || "");
      const author = normalizeShortText(req.query?.author || "");
      const genre = normalizeShortText(req.query?.genre || "");
      const language = normalizeShortText(req.query?.language || "") || "zh";
      const replaceBook = normalizeBoolean(req.query?.replace_book);

      const inferredTitle = normalizeShortText(
        String(rawFileName || "")
          .replace(/\.[^.]+$/, "")
          .trim(),
      );
      const uploadTitle = title || inferredTitle;
      const normalizedTitle = normalizeShortText(uploadTitle);

      const ext = sourceFormat === "epub" ? "epub" : "txt";
      const sourceSha256 = crypto.createHash("sha256").update(req.body).digest("hex");
      const storedName = `${sourceSha256}.${ext}`;
      const storedPath = path.join(BOOK_UPLOADS_DIR, storedName);

      let existingBook = null;
      if (normalizedTitle) {
        try {
          const booksDb = getBooksDbOrThrow();
          existingBook = booksDb
            .prepare(
              `
                SELECT
                  b.id,
                  b.title,
                  b.source_path,
                  COUNT(c.id) AS chapter_count
                FROM books b
                LEFT JOIN chapters c ON c.book_id = b.id
                WHERE lower(trim(b.title)) = lower(trim(?))
                GROUP BY b.id
                ORDER BY b.updated_at DESC, b.id DESC
                LIMIT 1
              `,
            )
            .get(normalizedTitle);
        } catch {
          existingBook = null;
        }
      }

      if (existingBook && !replaceBook) {
        res.status(409).json({
          code: "book_exists",
          message: `同名书籍已存在：${String(existingBook.title || normalizedTitle)}（${Number(existingBook.chapter_count || 0)}章）。是否替换？`,
          book: {
            id: Number(existingBook.id),
            title: String(existingBook.title || normalizedTitle),
            chapter_count: Number(existingBook.chapter_count || 0),
          },
        });
        return;
      }

      let latestSameSourceRun = null;
      try {
        const booksDb = getBooksDbOrThrow();
        latestSameSourceRun = booksDb
          .prepare(
            `
              SELECT
                run_id,
                source_path,
                source_format,
                started_at,
                finished_at,
                status,
                total_chapters,
                inserted_chapters,
                updated_chapters,
                skipped_chapters,
                error_message,
                created_at
              FROM ingest_runs
              WHERE source_path = ?
              ORDER BY id DESC
              LIMIT 1
            `,
          )
          .get(storedPath);
      } catch {
        latestSameSourceRun = null;
      }

      const latestTask = serializeIngestRun(latestSameSourceRun);
      if (latestTask && latestTask.status === "running") {
        res.status(409).json({
          code: "book_ingest_running",
          message: `相同文件内容正在解析中（任务 ${latestTask.run_id}）`,
          task: latestTask,
          source_sha256: sourceSha256,
        });
        return;
      }

      if (latestTask && latestTask.status === "succeeded") {
        res.status(409).json({
          code: "book_ingest_succeeded",
          message: `该文件内容已解析完成（任务 ${latestTask.run_id}），可直接使用`,
          task: latestTask,
          source_sha256: sourceSha256,
        });
        return;
      }

      try {
        fs.mkdirSync(BOOK_UPLOADS_DIR, { recursive: true });
        fs.writeFileSync(storedPath, req.body);

        const runId = `ingest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        let ingestSource = storedPath;
        if (replaceBook && existingBook) {
          const existingSourcePath = String(existingBook.source_path || "").trim();
          if (existingSourcePath) {
            fs.mkdirSync(path.dirname(existingSourcePath), { recursive: true });
            fs.writeFileSync(existingSourcePath, req.body);
            ingestSource = existingSourcePath;
          }
        }

        void runBookIngestCommand({
          source: ingestSource,
          format: sourceFormat,
          title: normalizedTitle,
          author,
          genre,
          language,
          replaceBook,
          runId,
        }).catch((error) => {
          console.error("[book-ingest] async task failed", error);
        });

        res.status(202).json({
          ok: true,
          run_id: runId,
          status: "queued",
          db_path: RESOLVED_BOOK_INGEST_DB_PATH,
          stored_file: storedPath,
          source_sha256: sourceSha256,
        });
      } catch (error) {
        res.status(500).json({ message: asMessage(error, "上传解析失败") });
      }
    },
  );

  app.post("/api/admin/books/:bookId/reparse", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
    const bookId = normalizePositiveInteger(req.params?.bookId);
    if (!bookId) {
      res.status(400).json({ message: "book_id 必须是正整数" });
      return;
    }

    const targetBook = getBookByBookId(bookId);
    if (!targetBook) {
      res.status(404).json({ message: "书籍不存在", code: "book_not_found" });
      return;
    }

    const sourcePath = String(targetBook.source_path || "").trim();
    if (!sourcePath) {
      res.status(400).json({ message: "书籍缺少 source_path，无法重解析", code: "book_source_missing" });
      return;
    }

    if (!fs.existsSync(sourcePath)) {
      res.status(400).json({ message: `源文件不存在：${sourcePath}`, code: "book_source_not_found" });
      return;
    }

    try {
      const booksDb = getBooksDbOrThrow();
      const runningRow = booksDb
        .prepare(
          `
            SELECT run_id
            FROM ingest_runs
            WHERE source_path = ? AND status = 'running'
            ORDER BY id DESC
            LIMIT 1
          `,
        )
        .get(sourcePath);

      if (runningRow?.run_id) {
        res.status(409).json({
          code: "book_ingest_running",
          message: `该书正在解析中（任务 ${String(runningRow.run_id)}）`,
          task: getIngestRunByRunId(String(runningRow.run_id)),
        });
        return;
      }
    } catch {
      // ignore lookup failure and continue to command execution
    }

    try {
      const runId = `ingest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      void runBookIngestCommand({
        source: sourcePath,
        format: targetBook.source_format,
        title: targetBook.title,
        author: targetBook.author,
        genre: targetBook.genre,
        language: targetBook.language,
        replaceBook: true,
        runId,
      }).catch((error) => {
        console.error("[book-ingest] reparse task failed", error);
      });

      res.status(202).json({
        ok: true,
        run_id: runId,
        status: "queued",
        book: {
          id: targetBook.id,
          title: targetBook.title,
          chapter_count: targetBook.chapter_count,
          source_name: path.basename(sourcePath),
        },
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "发起重解析失败") });
    }
  });

  app.get("/api/admin/books/summaries", requireAuth, requireAdmin, (req, res) => {
    const limit = Math.min(50, normalizePositiveInteger(req.query?.limit) || 10);
    const tasks = listSummaryRuns(limit);
    res.json({
      ok: true,
      db_path: RESOLVED_BOOK_INGEST_DB_PATH,
      limit,
      tasks,
    });
  });

  app.get("/api/admin/books/summaries/:runId", requireAuth, requireAdmin, (req, res) => {
    const task = getSummaryRunByRunId(req.params?.runId || "");
    if (!task) {
      res.status(404).json({ message: "未找到摘要任务", code: "book_summary_run_not_found" });
      return;
    }

    res.json({
      ok: true,
      db_path: RESOLVED_BOOK_INGEST_DB_PATH,
      task,
    });
  });

  app.get("/api/admin/books/summaries/:runId/items", requireAuth, requireAdmin, (req, res) => {
    const runId = normalizeShortText(req.params?.runId || "");
    if (!runId) {
      res.status(400).json({ message: "run_id 不能为空" });
      return;
    }

    const task = getSummaryRunByRunId(runId);
    if (!task) {
      res.status(404).json({ message: "未找到摘要任务", code: "book_summary_run_not_found" });
      return;
    }

    const limit = Math.min(500, normalizePositiveInteger(req.query?.limit) || 200);
    try {
      const booksDb = getBooksDbOrThrow();
      const rows = booksDb
        .prepare(
          `
            SELECT
              item.chapter_id,
              c.chapter_index,
              c.chapter_title,
              item.status,
              item.source_chars,
              item.chunks_count,
              item.error_message,
              item.updated_at
            FROM chapter_summary_run_items item
            JOIN chapter_summary_runs run ON run.id = item.summary_run_id
            LEFT JOIN chapters c ON c.id = item.chapter_id
            WHERE run.run_id = ?
            ORDER BY
              CASE item.status
                WHEN 'failed' THEN 0
                WHEN 'skipped' THEN 1
                ELSE 2
              END ASC,
              COALESCE(c.chapter_index, 0) ASC,
              item.id ASC
            LIMIT ?
          `,
        )
        .all(runId, limit);

      res.json({
        ok: true,
        run_id: runId,
        limit,
        task,
        items: rows
          .map((row) => serializeSummaryRunItem(row))
          .filter((item) => item),
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取摘要任务明细失败") });
    }
  });

  app.post("/api/admin/books/:bookId/summaries", requireAuth, requireCsrf, requireAdmin, async (req, res) => {
    const bookId = normalizePositiveInteger(req.params?.bookId);
    if (!bookId) {
      res.status(400).json({ message: "book_id 必须是正整数" });
      return;
    }

    const targetBook = getBookByBookId(bookId);
    if (!targetBook) {
      res.status(404).json({ message: "书籍不存在", code: "book_not_found" });
      return;
    }

    try {
      const booksDb = getBooksDbOrThrow();
      const runningRow = booksDb
        .prepare(
          `
            SELECT run_id
            FROM chapter_summary_runs
            WHERE scope_type = 'book' AND scope_id = ? AND status = 'running'
            ORDER BY id DESC
            LIMIT 1
          `,
        )
        .get(bookId);

      if (runningRow?.run_id) {
        res.status(409).json({
          code: "book_summary_running",
          message: `该书摘要任务正在进行中（任务 ${String(runningRow.run_id)}）`,
          task: getSummaryRunByRunId(String(runningRow.run_id)),
        });
        return;
      }
    } catch {
      // ignore lookup failure and continue to command execution
    }

    try {
      const runId = `summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const force = normalizeBoolean(req.query?.force ?? req.body?.force);
      const chunkSize = normalizePositiveInteger(req.query?.chunk_size ?? req.body?.chunk_size) || 1000;
      const summaryMaxChars = normalizePositiveInteger(req.query?.summary_max_chars ?? req.body?.summary_max_chars) || 200;

      startBookSummaryRunTask({
        runId,
        scopeType: "book",
        scopeId: bookId,
        userId: req.authUser?.id,
        force,
        chunkSize,
        summaryMaxChars,
      });

      res.status(202).json({
        ok: true,
        run_id: runId,
        status: "queued",
        book: {
          id: targetBook.id,
          title: targetBook.title,
          chapter_count: targetBook.chapter_count,
        },
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "创建摘要任务失败") });
    }
  });

  app.post("/api/admin/books/summaries/:runId/resume", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const sourceRunId = normalizeShortText(req.params?.runId || "");
    if (!sourceRunId) {
      res.status(400).json({ message: "run_id 不能为空" });
      return;
    }

    const sourceTask = getSummaryRunByRunId(sourceRunId);
    if (!sourceTask) {
      res.status(404).json({ message: "未找到摘要任务", code: "book_summary_run_not_found" });
      return;
    }

    if (sourceTask.status === "running") {
      res.status(409).json({
        code: "book_summary_running",
        message: `摘要任务仍在进行中（任务 ${sourceTask.run_id}）`,
        task: sourceTask,
      });
      return;
    }

    try {
      const booksDb = getBooksDbOrThrow();
      const runningRow = booksDb
        .prepare(
          `
            SELECT run_id
            FROM chapter_summary_runs
            WHERE scope_type = ? AND scope_id = ? AND status = 'running'
            ORDER BY id DESC
            LIMIT 1
          `,
        )
        .get(sourceTask.scope_type, sourceTask.scope_id);

      if (runningRow?.run_id) {
        res.status(409).json({
          code: "book_summary_running",
          message: `该范围已有进行中的摘要任务（任务 ${String(runningRow.run_id)}）`,
          task: getSummaryRunByRunId(String(runningRow.run_id)),
        });
        return;
      }
    } catch {
      // ignore lookup failure and continue to command execution
    }

    try {
      const resumeRunId = `summary_resume_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const force = normalizeBoolean(req.query?.force ?? req.body?.force);
      const chunkSize = normalizePositiveInteger(req.query?.chunk_size ?? req.body?.chunk_size) || 1000;
      const summaryMaxChars = normalizePositiveInteger(req.query?.summary_max_chars ?? req.body?.summary_max_chars) || 200;

      startBookSummaryRunTask({
        runId: resumeRunId,
        scopeType: sourceTask.scope_type,
        scopeId: sourceTask.scope_id,
        userId: req.authUser?.id,
        force,
        chunkSize,
        summaryMaxChars,
      });

      res.status(202).json({
        ok: true,
        resumed_from_run_id: sourceTask.run_id,
        run_id: resumeRunId,
        status: "queued",
        scope_type: sourceTask.scope_type,
        scope_id: sourceTask.scope_id,
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "继续摘要任务失败") });
    }
  });

  app.post("/api/admin/books/summaries/:runId/cancel", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const runId = normalizeShortText(req.params?.runId || "");
    if (!runId) {
      res.status(400).json({ message: "run_id 不能为空" });
      return;
    }

    const task = getSummaryRunByRunId(runId);
    if (!task) {
      res.status(404).json({ message: "未找到摘要任务", code: "book_summary_run_not_found" });
      return;
    }

    if (task.status === "succeeded" || task.status === "failed") {
      res.status(409).json({
        code: "book_summary_not_running",
        message: `任务已结束（${task.status}）`,
        task,
      });
      return;
    }

    const reason = String(req.body?.reason || "").trim() || "任务已由管理员取消";
    const control = activeBookSummaryControllers.get(runId);
    let signalSent = false;
    if (control && typeof control.kill === "function") {
      signalSent = Boolean(control.kill("SIGTERM"));
    }
    const cancelResult = markSummaryRunAsCancelled(runId, reason);
    const updatedTask = cancelResult?.task || task;

    if (cancelResult?.writeError) {
      res.status(500).json({
        code: "book_summary_cancel_write_failed",
        message: `取消请求已接收，但写入状态失败：${cancelResult.writeError}`,
        run_id: runId,
        signal_sent: signalSent,
        task: updatedTask,
      });
      return;
    }

    if (!cancelResult?.changes && (updatedTask?.status === "running" || updatedTask?.status === "queued")) {
      res.status(409).json({
        code: "book_summary_cancel_not_applied",
        message: "取消信号已发送，但任务状态尚未更新，请稍后刷新重试",
        run_id: runId,
        signal_sent: signalSent,
        task: updatedTask,
      });
      return;
    }

    res.json({
      ok: true,
      run_id: runId,
      signal_sent: signalSent,
      task: updatedTask,
      message: signalSent ? "取消信号已发送，任务状态已更新" : "任务状态已更新为已取消",
    });
  });

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
                 json_extract(c.meta_json, '$.summary.text') AS summary_text,
                 json_extract(c.meta_json, '$.summary.status') AS summary_status,
                 json_extract(c.meta_json, '$.summary.updated_at') AS summary_updated_at,
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
          const summaryText = String(row.summary_text || "").trim();
          const summaryStatus = String(row.summary_status || "").trim();
          const summaryUpdatedAt = row.summary_updated_at ? String(row.summary_updated_at) : null;
          const previewText = summaryText || String(row.preview || "");

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
            preview: previewText,
            summary_text: summaryText,
            summary_status: summaryStatus,
            summary_updated_at: summaryUpdatedAt,
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

  app.get("/api/admin/book-chapters/:chapterId/text", requireAuth, requireAdmin, (req, res) => {
    const chapterId = normalizePositiveInteger(req.params?.chapterId);
    if (!chapterId) {
      res.status(400).json({ message: "chapter_id 必须是正整数" });
      return;
    }

    try {
      const booksDatabase = getBooksDbOrThrow();
      const row = booksDatabase
        .prepare(
          `
            SELECT
              c.id,
              c.book_id,
              b.title AS book_title,
              b.author AS book_author,
              c.chapter_index,
              c.chapter_title,
              c.char_count,
              c.word_count,
              c.chapter_text,
              c.meta_json
            FROM chapters c
            JOIN books b ON b.id = c.book_id
            WHERE c.id = ?
            LIMIT 1
          `,
        )
        .get(chapterId);

      if (!row) {
        res.status(404).json({ message: "章节不存在", code: "chapter_not_found" });
        return;
      }

      res.json({
        ok: true,
        db_path: RESOLVED_BOOK_INGEST_DB_PATH,
        chapter: {
          id: Number(row.id),
          book_id: Number(row.book_id),
          book_title: String(row.book_title || ""),
          book_author: String(row.book_author || ""),
          chapter_index: Number(row.chapter_index),
          chapter_title: String(row.chapter_title || ""),
          char_count: Number(row.char_count || 0),
          word_count: Number(row.word_count || 0),
          chapter_text: String(row.chapter_text || ""),
          meta_json: safeParseJsonObject(row.meta_json),
        },
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取章节原文失败") });
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
