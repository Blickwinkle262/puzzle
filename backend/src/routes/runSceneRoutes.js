import fs from "node:fs";
import path from "node:path";

import express from "express";

import { AppError } from "../utils/appError.js";

export function registerRunSceneRoutes(app, deps) {
  const {
    createGenerationSceneImageAttempt,
    deleteGenerationSceneDraft,
    ensureGenerationRunWritable,
    finalizeGenerationSceneImageAttempt,
    getGenerationJobByRunId,
    getGenerationSceneByIndex,
    listGenerationSceneAttempts,
    listGenerationScenes,
    normalizePositiveInteger,
    normalizeRunId,
    refreshGenerationRunState,
    resolveGenerationRunImagesDir,
    resolveStoryAssetUrlFromFsPath,
    requireAdmin,
    requireAuth,
    requireCsrf,
    setGenerationSceneImageResult,
    summarizeGenerationScenes,
    updateGenerationSceneDraft,
  } = deps;

  const route = (handler) => (req, res, next) => {
    Promise.resolve().then(() => handler(req, res, next)).catch(next);
  };

  const normalizeUploadFileName = (value) => String(value || "")
    .trim()
    .replace(/[\\/\r\n]+/g, "_")
    .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  const safeSceneSlug = (value, fallback) => {
    const normalized = String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    return normalized || fallback;
  };

  app.post(
    "/api/runs/:runId/scenes/:sceneIndex/upload-image",
    requireAuth,
    requireCsrf,
    requireAdmin,
    express.raw({
      type: ["application/octet-stream", "image/png", "image/jpeg", "image/webp"],
      limit: "20mb",
    }),
    route((req, res) => {
      const runId = normalizeRunId(req.params.runId);
      const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
      if (!runId || !sceneIndex) {
        throw new AppError(400, "run_scene_invalid_params", "run_id 或 scene_index 不合法");
      }

      if (!Buffer.isBuffer(req.body) || req.body.length <= 0) {
        throw new AppError(400, "run_scene_upload_empty", "上传内容为空");
      }

      const writable = ensureGenerationRunWritable(runId);
      if (writable.status !== 200) {
        throw new AppError(
          writable.status,
          "run_scene_upload_rejected",
          writable.message || "当前任务不允许上传图片",
        );
      }

      const scene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: false });
      if (!scene) {
        throw new AppError(404, "run_scene_not_found", "scene 不存在");
      }

      const mimeType = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      const extByMime = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/webp": ".webp",
        "application/octet-stream": "",
      };

      const fileNameHeader = req.headers["x-file-name"];
      const rawFileName = Array.isArray(fileNameHeader)
        ? String(fileNameHeader[0] || "")
        : String(fileNameHeader || req.query?.filename || "");
      const safeFileName = normalizeUploadFileName(rawFileName);
      const extFromName = path.extname(safeFileName).toLowerCase();
      const supportedExt = new Set([".png", ".jpg", ".jpeg", ".webp"]);
      const fileExt = supportedExt.has(extFromName) ? extFromName : (extByMime[mimeType] || "");

      if (!fileExt) {
        throw new AppError(400, "run_scene_upload_format_invalid", "仅支持上传 PNG/JPG/WebP 图片");
      }

      const imagesDir = resolveGenerationRunImagesDir(runId);
      const manualDir = path.join(imagesDir, "manual_uploads");
      fs.mkdirSync(manualDir, { recursive: true });

      const sceneSlug = safeSceneSlug(scene.title, `scene_${scene.scene_index}`);
      const outputFileName = [
        `scene_${String(scene.scene_index).padStart(3, "0")}`,
        sceneSlug,
        Date.now().toString(36),
      ].join("_") + fileExt;
      const imagePath = path.join(manualDir, outputFileName);
      fs.writeFileSync(imagePath, req.body);

      const imageUrl = resolveStoryAssetUrlFromFsPath(imagePath);
      const attemptRow = createGenerationSceneImageAttempt({
        runId,
        sceneIndex,
        provider: "manual_upload",
        model: `manual_upload:${fileExt.replace(/^\./, "")}`,
        imagePrompt: scene.image_prompt,
      });
      const attemptNo = Number(attemptRow?.attempt_no || 1);

      finalizeGenerationSceneImageAttempt({
        runId,
        sceneIndex,
        attemptNo,
        status: "succeeded",
        imageUrl,
        imagePath,
        errorMessage: "",
        latencyMs: 0,
      });

      setGenerationSceneImageResult({
        runId,
        sceneIndex,
        status: "success",
        imageUrl,
        imagePath,
        errorMessage: "",
      });

      const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
      const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
      const attempts = listGenerationSceneAttempts(runId, sceneIndex);
      res.json({
        ok: true,
        run_id: runId,
        job: latestJob,
        scene: latestScene,
        attempt: attempts.length > 0 ? attempts[attempts.length - 1] : null,
        counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
      });
    }),
  );

  app.patch("/api/runs/:runId/scenes/:sceneIndex", requireAuth, requireCsrf, requireAdmin, route((req, res) => {
    const runId = normalizeRunId(req.params.runId);
    const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
    if (!runId || !sceneIndex) {
      throw new AppError(400, "run_scene_invalid_params", "run_id 或 scene_index 不合法");
    }

    const result = updateGenerationSceneDraft({
      runId,
      sceneIndex,
      payload: req.body,
    });

    if (result.status !== 200) {
      throw new AppError(
        result.status,
        "run_scene_update_rejected",
        result.message || "更新场景草稿失败",
      );
    }

    const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
    const latestScene = getGenerationSceneByIndex(runId, sceneIndex, { include_deleted: true });
    res.json({
      ok: true,
      run_id: runId,
      job: latestJob,
      scene: latestScene,
      counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
    });
  }));

  app.delete("/api/runs/:runId/scenes/:sceneIndex", requireAuth, requireCsrf, requireAdmin, route((req, res) => {
    const runId = normalizeRunId(req.params.runId);
    const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
    if (!runId || !sceneIndex) {
      throw new AppError(400, "run_scene_invalid_params", "run_id 或 scene_index 不合法");
    }

    const result = deleteGenerationSceneDraft({
      runId,
      sceneIndex,
    });

    if (result.status !== 200) {
      throw new AppError(
        result.status,
        "run_scene_delete_rejected",
        result.message || "删除场景草稿失败",
      );
    }

    const latestJob = refreshGenerationRunState(runId) || getGenerationJobByRunId(runId);
    res.json({
      ok: true,
      run_id: runId,
      job: latestJob,
      counts: summarizeGenerationScenes(listGenerationScenes(runId, { include_deleted: true })),
    });
  }));
}
