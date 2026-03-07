import { AppError } from "../utils/appError.js";

export function registerGenerationReviewRetryRoutes(app, deps) {
  const {
    normalizePositiveInteger,
    requireAdmin,
    requireAuth,
    requireCsrf,
    retryGenerationCandidateImage,
  } = deps;

  const asyncRoute = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };

  app.post(
    "/api/admin/generation-jobs/:runId/candidates/:sceneIndex/retry-image",
    requireAuth,
    requireCsrf,
    requireAdmin,
    asyncRoute(async (req, res) => {
      const runId = String(req.params.runId || "").trim();
      const sceneIndex = normalizePositiveInteger(req.params.sceneIndex);
      if (!runId || !sceneIndex) {
        throw new AppError(400, "review_retry_invalid_params", "run_id 或 scene_index 不合法");
      }

      const payload = await retryGenerationCandidateImage({
        runId,
        sceneIndex,
        requestedBy: req.authUser?.username || "",
      });

      res.json(payload);
    }),
  );
}
