import fs from "node:fs";
import path from "node:path";

export function createGenerationPublishService(options = {}) {
  const {
    db,
    storyPublicPrefix,
    storiesRootDir,
    storyGeneratorOutputRoot,
    storyIndexFile,
    storyGeneratorIndexFile,
    resolveStoryAssetFsPath,
    readJsonSafe,
    normalizeIntegerInRange,
    normalizeStoryBookId,
    normalizeShortText,
    randomToken,
    nowIso,
    syncBooksGenerationLink,
  } = options;

  function resolveStoryAssetUrlFromFsPath(filePath) {
    const normalizedPath = path.normalize(String(filePath || "").trim());
    if (!normalizedPath) {
      return "";
    }

    const normalizedStoriesRoot = path.normalize(storiesRootDir);
    if (normalizedPath !== normalizedStoriesRoot && !normalizedPath.startsWith(`${normalizedStoriesRoot}${path.sep}`)) {
      return "";
    }

    const relativePath = path.relative(normalizedStoriesRoot, normalizedPath);
    if (!relativePath || relativePath.startsWith("..")) {
      return "";
    }

    return `${storyPublicPrefix}/${relativePath.split(path.sep).join("/")}`;
  }

  function normalizeGeneratedStoryId(value) {
    const normalized = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");

    return normalized;
  }

  function resolveGenerationPublishStoryId({ runId, job, summary }) {
    const summaryStoryId = normalizeGeneratedStoryId(summary?.story_id);
    if (summaryStoryId) {
      return summaryStoryId;
    }

    const payloadStoryId = normalizeGeneratedStoryId(job?.payload?.story_id);
    if (payloadStoryId) {
      return payloadStoryId;
    }

    const dateStamp = String(job?.target_date || "")
      .replace(/[^0-9]/g, "")
      .slice(0, 8);
    const runPart = normalizeGeneratedStoryId(runId).slice(0, 24) || randomToken().slice(0, 6);
    return normalizeGeneratedStoryId(`story-${dateStamp || "unknown"}-${runPart}`) || `story-${Date.now()}`;
  }

  function resolveCandidateImageSourcePath(candidate) {
    const directPath = String(candidate?.image_path || "").trim();
    if (directPath) {
      try {
        const normalized = path.normalize(directPath);
        if (fs.existsSync(normalized) && fs.statSync(normalized).isFile()) {
          return normalized;
        }
      } catch {
        // fallback to image_url
      }
    }

    const imageUrl = String(candidate?.image_url || "").trim();
    if (imageUrl) {
      try {
        const fromUrl = resolveStoryAssetFsPath(imageUrl);
        if (fromUrl && fs.existsSync(fromUrl) && fs.statSync(fromUrl).isFile()) {
          return fromUrl;
        }
      } catch {
        return "";
      }
    }

    return "";
  }

  function writeJsonAtomic(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomToken().slice(0, 6)}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, filePath);
  }

  function upsertStoryIndexEntry({
    indexFile,
    storyId,
    title,
    description,
    cover,
    manifest,
    bookId,
    bookTitle,
  }) {
    let payload = { version: 1, stories: [] };
    if (fs.existsSync(indexFile)) {
      const existing = readJsonSafe(indexFile);
      if (existing && typeof existing === "object") {
        payload = {
          ...payload,
          ...existing,
        };
      }
    }

    const stories = Array.isArray(payload.stories) ? payload.stories.filter((item) => item && typeof item === "object") : [];
    const filteredStories = stories.filter((item) => String(item.id || "") !== storyId);
    const maxOrder = filteredStories.reduce((max, item) => {
      const order = Number(item.order);
      return Number.isFinite(order) ? Math.max(max, order) : max;
    }, 0);

    const entry = {
      id: storyId,
      title,
      description,
      cover,
      manifest,
      order: maxOrder + 1,
    };

    const normalizedBookId = normalizeStoryBookId(bookId);
    const normalizedBookTitle = normalizeShortText(bookTitle);
    if (normalizedBookId) {
      entry.book_id = normalizedBookId;
    }
    if (normalizedBookTitle) {
      entry.book_title = normalizedBookTitle;
    }

    filteredStories.push(entry);
    payload.version = Number(payload.version) || 1;
    payload.stories = filteredStories.sort((first, second) => {
      const firstOrder = Number.isFinite(Number(first.order)) ? Number(first.order) : Number.MAX_SAFE_INTEGER;
      const secondOrder = Number.isFinite(Number(second.order)) ? Number(second.order) : Number.MAX_SAFE_INTEGER;
      if (firstOrder !== secondOrder) {
        return firstOrder - secondOrder;
      }
      return String(first.id || "").localeCompare(String(second.id || ""));
    });

    writeJsonAtomic(indexFile, payload);
  }

  function appendRunEvent(eventLogFile, payload) {
    if (!eventLogFile) {
      return;
    }

    try {
      fs.mkdirSync(path.dirname(eventLogFile), { recursive: true });
      const line = JSON.stringify(payload);
      fs.appendFileSync(eventLogFile, `${line}\n`, "utf-8");
    } catch {
      // ignore event append failures
    }
  }

  function publishSelectedGenerationCandidates({ runId, job, summary, selectedCandidates }) {
    const sortedCandidates = [...selectedCandidates].sort((first, second) => first.scene_index - second.scene_index);
    if (sortedCandidates.length === 0) {
      throw new Error("没有可发布的候选关卡");
    }

    const missingSceneIndexes = [];
    const copiedScenes = [];
    const storyId = resolveGenerationPublishStoryId({ runId, job, summary });
    const stagingDir = path.join(storyGeneratorOutputRoot, `.staging_${storyId}_${runId}`);
    const stagingImagesDir = path.join(stagingDir, "images");

    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingImagesDir, { recursive: true });

    for (let index = 0; index < sortedCandidates.length; index += 1) {
      const candidate = sortedCandidates[index];
      const sourcePath = resolveCandidateImageSourcePath(candidate);
      if (!sourcePath) {
        missingSceneIndexes.push(candidate.scene_index);
        continue;
      }

      const ext = path.extname(sourcePath).toLowerCase();
      const safeExt = ext === ".jpg" || ext === ".jpeg" || ext === ".webp" ? ext : ".png";
      const fileName = `scene_${String(index + 1).padStart(3, "0")}${safeExt}`;
      const targetPath = path.join(stagingImagesDir, fileName);

      fs.copyFileSync(sourcePath, targetPath);
      copiedScenes.push({
        candidate,
        file_name: fileName,
        source_path: sourcePath,
      });
    }

    if (missingSceneIndexes.length > 0) {
      throw new Error(`候选图片缺失，scene_index=${missingSceneIndexes.join(", ")}`);
    }

    if (copiedScenes.length === 0) {
      throw new Error("没有可用图片可发布");
    }

    const firstImageName = copiedScenes[0].file_name;
    const coverExt = path.extname(firstImageName) || ".png";
    const coverName = `cover${coverExt}`;
    fs.copyFileSync(path.join(stagingImagesDir, firstImageName), path.join(stagingDir, coverName));

    const storyTitle = String(summary?.title || job?.payload?.chapter_title || "").trim() || storyId;
    const storyDescription = String(summary?.description || "").trim();
    const overviewTitle = String(summary?.story_overview_title || "").trim();
    const overviewParagraphs = Array.isArray(summary?.story_overview_paragraphs)
      ? summary.story_overview_paragraphs.map((item) => String(item || "").trim()).filter((item) => item.length > 0)
      : [];

    const levels = copiedScenes.map((item, index) => ({
      id: `${storyId}_${String(index + 1).padStart(2, "0")}`,
      title: item.candidate.title || `关卡 ${index + 1}`,
      description: item.candidate.description || item.candidate.title || `关卡 ${index + 1}`,
      story_text: item.candidate.story_text || item.candidate.description || item.candidate.title || "",
      grid: {
        rows: normalizeIntegerInRange(item.candidate.grid_rows, 2, 20) || 6,
        cols: normalizeIntegerInRange(item.candidate.grid_cols, 2, 20) || 4,
      },
      source_image: `images/${item.file_name}`,
      content_version: 1,
      time_limit_sec: normalizeIntegerInRange(item.candidate.time_limit_sec, 30, 3600) || 180,
      shuffle: {
        seed: 1000 + index + 1,
        mode: "grid_shuffle",
      },
      mobile: {
        preferred_orientation: "portrait",
        orientation_hint: "本关建议竖屏体验",
      },
    }));

    const manifestPayload = {
      id: storyId,
      title: storyTitle,
      description: storyDescription,
      cover: coverName,
      story_overview_title: overviewTitle,
      story_overview_paragraphs: overviewParagraphs,
      levels,
    };

    writeJsonAtomic(path.join(stagingDir, "story.json"), manifestPayload);

    const finalStoryDir = path.join(storyGeneratorOutputRoot, storyId);
    fs.rmSync(finalStoryDir, { recursive: true, force: true });
    fs.renameSync(stagingDir, finalStoryDir);

    const manifestUrl = `${storyPublicPrefix}/${storyId}/story.json`;
    const coverUrl = `${storyPublicPrefix}/${storyId}/${coverName}`;
    const indexFiles = [...new Set([storyIndexFile, storyGeneratorIndexFile].filter((item) => Boolean(item)))];

    for (const indexFile of indexFiles) {
      upsertStoryIndexEntry({
        indexFile,
        storyId,
        title: manifestPayload.title,
        description: manifestPayload.description,
        cover: coverUrl,
        manifest: manifestUrl,
        bookId: job?.payload?.book_id ?? summary?.book_id,
        bookTitle: job?.payload?.book_title ?? summary?.book_title,
      });
    }

    const now = nowIso();
    const nextPayload = {
      ...(job?.payload && typeof job.payload === "object" ? job.payload : {}),
      story_id: storyId,
      review_mode: true,
      published_at: now,
    };

    db.prepare(
      `
    UPDATE generation_jobs
    SET payload_json = ?,
        status = 'succeeded',
        review_status = 'published',
        flow_stage = 'published',
        published_at = COALESCE(published_at, ?),
        ended_at = COALESCE(ended_at, ?),
        updated_at = ?
    WHERE run_id = ?
  `,
    ).run(JSON.stringify(nextPayload), now, now, now, runId);

    db.prepare(
      `
    INSERT INTO generation_job_meta (
      run_id,
      result_story_id,
      job_kind,
      created_at,
      updated_at
    ) VALUES (?, ?, 'story_generation', ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      result_story_id = excluded.result_story_id,
      updated_at = excluded.updated_at
  `,
    ).run(runId, storyId, now, now);

    if (job.summary_path) {
      const nextSummary = {
        ...(summary && typeof summary === "object" ? summary : {}),
        story_id: storyId,
        generated_scenes: levels.length,
        review_mode: true,
        review_status: "published",
        published_at: now,
        publish: {
          mode: "selected",
          story_id: storyId,
          story_dir: finalStoryDir,
          manifest: path.join(finalStoryDir, "story.json"),
          level_count: levels.length,
          selected_count: selectedCandidates.length,
          published_at: now,
        },
      };
      writeJsonAtomic(job.summary_path, nextSummary);
    }

    appendRunEvent(job.event_log_file, {
      ts: now,
      event: "publish.selected.completed",
      run_id: runId,
      story_id: storyId,
      level_count: levels.length,
      selected_count: selectedCandidates.length,
      manifest: manifestUrl,
    });

    if (typeof syncBooksGenerationLink === "function") {
      try {
        syncBooksGenerationLink({
          runId,
          chapterId: job?.payload?.chapter_id,
          storyId,
          summaryPath: job?.summary_path,
        });
      } catch {
        // keep publish flow robust even if books sync fails
      }
    }

    return {
      story_id: storyId,
      manifest: manifestUrl,
      cover: coverUrl,
      level_count: levels.length,
      selected_count: selectedCandidates.length,
      published_at: now,
    };
  }

  return {
    appendRunEvent,
    normalizeGeneratedStoryId,
    publishSelectedGenerationCandidates,
    resolveStoryAssetUrlFromFsPath,
    writeJsonAtomic,
  };
}
