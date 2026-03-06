# Generation Scene-First 升级手册（旧系统 -> 新系统）

适用场景：另一台服务器从旧版章节生成系统升级到当前 scene-first 架构，确保旧数据迁移到新表并保持接口可用。

## 0. 版本变化（2026-03-06 起）

- 旧创建入口 `POST /api/admin/generate-story` 默认下线（返回 `410 Gone`）。
- 新入口改为 run/scenes 原子流程：
  - `POST /api/runs/:runId/generate-text`
  - `POST /api/runs/:runId/scenes/:sceneIndex/generate-image`
  - `POST /api/runs/:runId/scenes/generate-images-batch`
  - `POST /api/runs/:runId/publish`

如需紧急兼容旧入口，可临时设置：`GENERATION_LEGACY_CREATE_ENABLED=1`。

## 1. 升级前备份（必须）

```bash
cp backend/data/puzzle.sqlite backend/data/puzzle.sqlite.bak.$(date +%Y%m%d%H%M%S)
cp -R backend/data/generated backend/data/generated.bak.$(date +%Y%m%d%H%M%S)
```

## 2. 安装依赖

```bash
npm --prefix backend ci
```

Python 依赖也要在执行原子命令的解释器里可用（至少包含 `openai`）：

```bash
uv sync
```

如果 backend 不是用 `.venv/bin/python` 启动原子脚本，建议显式设置：

```bash
export STORY_GENERATOR_PYTHON_CMD="uv run python"
```

## 3. 一键升级命令

```bash
npm --prefix backend run upgrade:generation-scene-first
```

如果数据库不在默认路径：

```bash
DB_PATH=/abs/path/to/puzzle.sqlite npm --prefix backend run upgrade:generation-scene-first
```

该命令会按顺序执行：

1. `migrate`（包含 `0012/0013`）
2. `backfill-generation-review-state`
3. `backfill-generation-scenes-v2`
4. 输出一致性报告（jobs/scenes/attempts/stage 分布）

## 4. 升级后核验

推荐至少检查以下两点：

- `orphan_scenes == 0`
- `orphan_attempts == 0`

如果存在 `jobs_without_scenes > 0`，先查看报告里的 `sample_runs_without_scenes`，通常是历史异常 run 或空任务；不会导致新流程崩溃，但建议后续手工清理或补录。

## 5. 服务切换建议顺序

1. 停写（暂停旧 worker）
2. 执行升级脚本
3. 启动新 backend
4. 启动新 worker（走 atomic CLI）
5. 打开管理后台验证：可生成文案、可按 scene 出图、可发布

## 6. 回滚

若升级异常：

1. 停服务
2. 用备份覆盖 `puzzle.sqlite`
3. 恢复 `backend/data/generated` 备份
4. 回滚代码版本再启动

## 7. 说明

- 新代码会优先读 `generation_job_scenes`。
- 对未回填的历史 run，接口读取时仍有兼容 materialize 兜底。
- 建议在生产先跑一次一键升级，避免首次访问时才触发懒加载迁移。
