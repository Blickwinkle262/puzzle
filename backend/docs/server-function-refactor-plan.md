# `server.js` 函数级拆分计划

目标：把当前 `backend/src/server.js` 继续从 5000+ 行拆成可维护模块，`server.js` 最终只保留启动编排与依赖装配。

## 0. 已完成（本轮前后）

- 路由已大量外置到 `backend/src/routes/*.js`
  - `authRoutes.js`
  - `internalWorkerRoutes.js`
  - `runLifecycleRoutes.js`
  - `runGenerateTextRoutes.js`
  - `runGenerateImageRoutes.js`
  - `runSceneRoutes.js`
  - `generationReviewRoutes.js`
  - `generationReviewRetryRoutes.js`
  - `adminUserRoutes.js`
  - `adminLevelRoutes.js`
  - `adminLegacyGenerationRoutes.js`
  - `playerRoutes.js`

## 1. 目标目录结构（函数驱动）

建议逐步形成：

```text
backend/src/
  app/
    createApp.js
    bootstrap.js
  config/
    env.js
    paths.js
    security.js
  db/
    schema.js
    migrations.js
    sqlite.js
  middleware/
    auth.js
    csrf.js
    admin.js
    rateLimit.js
    workerAuth.js
  repositories/
    userRepo.js
    sessionRepo.js
    runRepo.js
    sceneRepo.js
    retryRepo.js
    levelOverrideRepo.js
  services/
    authService.js
    storyCatalogService.js
    generationRunService.js
    generationReviewService.js
    generationWorkerService.js
    publishService.js
    adminLevelService.js
  utils/
    normalize.js
    fsSafe.js
    jsonSafe.js
    time.js
```

## 2. 函数迁移清单（按职责分组）

### A. 配置/安全（`config/*`）

- `resolveSessionTtlMs`
- `resolveCookieSecure`
- `resolveCookieSameSite`
- `resolveTrustProxySetting`
- `resolvePublicRegistrationEnabled`
- `resolveAdminUsernameFallbackEnabled`
- `assertProductionWorkerToken`
- `assertProductionRegistrationSafety`

### B. 中间件与会话（`middleware/*` + `services/authService.js`）

- `requireAuth`
- `requireCsrf`
- `requireAdmin`
- `requireWorkerAuth`
- `extractSessionToken`
- `extractCsrfHeader`
- `extractWorkerToken`
- `readCookie`
- `setAuthCookies`
- `clearAuthCookies`
- `createSession`
- `rotateSession`
- `pruneExpiredSessions`
- `issuePasswordResetToken`
- `consumePasswordResetToken`
- `pruneExpiredPasswordResetTokens`
- `hashSessionToken`
- `hashTokenForStorage`

### C. 限流（`middleware/rateLimit.js`）

- `authRateLimitKey`
- `pruneAuthRateLimitBuckets`
- `passAuthRateLimit`
- `registerRateLimitKey`
- `pruneRegisterRateLimitBuckets`
- `passRegisterRateLimit`
- `passwordResetRateLimitKey`
- `prunePasswordResetRateLimitBuckets`
- `passPasswordResetRateLimit`
- `clearAuthRateLimit`

### D. 故事与关卡读取（`services/storyCatalogService.js`）

- `loadStoryCatalog`
- `loadStoryById`
- `listStoriesForUser`
- `getLevelProgressMap`
- `normalizeLevel`
- `normalizeAudioMap`
- `normalizeAssetPath`
- `resolveManifestFsPath`
- `resolveStoryBookMeta`
- `buildGeneratedStoryBookMap`
- `listStoryBookLinksFromBooksDb`

### E. 生成任务主流程（`services/generationRunService.js`）

- `createOrUpdateAtomicGenerationRun`
- `ensureGenerationRunWritable`
- `cancelGenerationRun`
- `deleteGenerationRun`
- `enqueueGenerationJob`
- `claimGenerationJob`
- `completeGenerationJobByRunId`
- `refreshGenerationRunState`
- `listGenerationJobs`
- `getGenerationJobByRunId`
- `serializeGenerationJobRow`

### F. scene / attempt / retry（`repositories/sceneRepo.js` + `services/generationReviewService.js`）

- `hasGenerationSceneRows`
- `listGenerationScenes`
- `getGenerationSceneByIndex`
- `replaceGenerationScenes`
- `createGenerationSceneImageAttempt`
- `finalizeGenerationSceneImageAttempt`
- `setGenerationSceneImageRunning`
- `setGenerationSceneImageResult`
- `listGenerationSceneAttempts`
- `enqueueGenerationCandidateImageRetry`
- `claimGenerationCandidateImageRetry`
- `completeGenerationCandidateImageRetry`

### G. 发布与索引（`services/publishService.js`）

- `publishSelectedGenerationCandidates`
- `upsertStoryIndexEntry`
- `resolveGenerationPublishStoryId`
- `resolveCandidateImageSourcePath`
- `resolveStoryAssetUrlFromFsPath`
- `resolveStoryAssetFsPath`
- `resolveStoriesRootDir`
- `ensureStoryIndexFile`

### H. 通用工具（`utils/*`）

- 归一化函数：`normalize*` 系列
- JSON/IO：`readJsonSafe`、`writeJsonAtomic`、`safeParseJsonObject`、`safeParseJsonArray`
- 时间/错误：`nowIso`、`asMessage`
- 路径安全：`resolveProjectPath`、`isPathInside`

## 3. 拆分顺序（降低风险）

1. **先抽纯函数**（无 DB、无 Express）
2. **再抽 repo**（仅 SQL）
3. **再抽 service**（组合 repo）
4. **最后抽 middleware 与 app bootstrap**

每一步都保持：

- 行为不变（无功能重写）
- 单步可回滚
- 单模块不超过 500 行（超了继续二拆）

## 4. 本周可执行里程碑

- M1：`config/*` + `utils/normalize.js` + `utils/jsonSafe.js`
- M2：`repositories/sessionRepo.js` + `services/authService.js` + `middleware/auth.js`
- M3：`repositories/runRepo.js` + `repositories/sceneRepo.js`
- M4：`services/generationRunService.js` + `services/generationReviewService.js`
- M5：`app/createApp.js`，`server.js` 仅保留 `bootstrap` 入口
