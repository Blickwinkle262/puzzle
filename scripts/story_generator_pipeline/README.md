# Story Generator Pipeline

可手动触发的故事生成流程：从原文生成分镜 JSON，再批量生图，过滤失败片段，最终发布到后端统一资源目录（默认 `backend/data/generated/content/stories`）。

## 目录结构

```text
scripts/story_generator_pipeline/
  main.py
  workflow.py
  config.py
  story_selector.py
  story_to_json.py
  image_generator.py
  filter.py
  publisher.py
  prompts/
    story_system_prompt.txt
    story_user_prompt_template.txt
    image_prompt_suffix.txt
  output/
```

## Prompt 审核位置

- `scripts/story_generator_pipeline/prompts/story_system_prompt.txt`
- `scripts/story_generator_pipeline/prompts/story_user_prompt_template.txt`
- `scripts/story_generator_pipeline/prompts/image_prompt_suffix.txt`

模板变量（在 `story_user_prompt_template.txt` 中）：

- `{{SOURCE_NAME}}`
- `{{CANDIDATE_SCENES}}`
- `{{SOURCE_TEXT}}`

## 运行

```bash
export AIHUBMIX_API_KEY="<your-key>"
python scripts/story_generator_pipeline/generate_story.py
```

常用参数：

```bash
python scripts/story_generator_pipeline/generate_story.py \
  --target-date 2026-02-27 \
  --candidate-scenes 15 \
  --min-scenes 10 \
  --max-scenes 15 \
  --concurrency 3 \
  --image-size 2K \
  --output-root backend/data/generated/content/stories \
  --index-file backend/data/generated/content/stories/index.json \
  --log-file scripts/story_generator/output/logs/pipeline.log \
  --event-log-file scripts/story_generator/output/logs/events.jsonl
```

仅跑流程不发布（保留 summary）：

```bash
python scripts/story_generator_pipeline/generate_story.py --dry-run
```

## 日志与事件（JSONL）

- 标准日志默认：`scripts/story_generator/output/logs/story_generator_pipeline.log`
- 事件日志默认：`scripts/story_generator/output/logs/events.jsonl`
- 两者都使用滚动策略（RotatingFileHandler），可通过 CLI 或环境变量覆盖

推荐参数：

```bash
python scripts/story_generator_pipeline/generate_story.py \
  --log-level INFO \
  --log-max-bytes 10485760 \
  --log-backup-count 5 \
  --event-log-max-bytes 20971520 \
  --event-log-backup-count 10
```

对应环境变量（Docker 里直接配即可）：

- `STORY_GENERATOR_LOG_LEVEL`
- `STORY_GENERATOR_LOG_FILE`
- `STORY_GENERATOR_LOG_MAX_BYTES`
- `STORY_GENERATOR_LOG_BACKUP_COUNT`
- `STORY_GENERATOR_EVENT_LOG_FILE`
- `STORY_GENERATOR_EVENT_LOG_MAX_BYTES`
- `STORY_GENERATOR_EVENT_LOG_BACKUP_COUNT`

事件日志是 JSONL（每行一个事件对象），前端可以直接 tail/读取做进度展示。例如：

```json
{"ts":"2026-03-03T09:01:22.123Z","event":"images.scene.completed","run_id":"run_...","scene_id":4,"status":"success","completed":7,"total":15,"progress":0.4667}
```

## 测试

```bash
python -m unittest \
  tests.test_story_generator_logging \
  tests.test_story_generator_selector \
  tests.test_story_generator_to_json \
  tests.test_story_generator_image_generator \
  tests.test_story_generator_filter \
  tests.test_story_generator_workflow
```

## 设计说明

- `story_to_json.py` 使用 async 调用 Qwen，解析严格 JSON，并确保 `image_prompt` 包含 `--ar 9:16`
- `image_generator.py` 使用 async + semaphore 控制并发，单张失败不会中断整批
- `filter.py` 只保留成功片段，失败原因单独记录
- `publisher.py` 用 staging 目录原子发布 `story.json` 与 `index.json`
- `workflow.py` 负责串联全流程并输出每日 summary（`output/story_YYYY-MM-DD.json`）

## 队列 Worker（配合 backend generation_jobs）

当后端通过 `/api/admin/generate-story` 创建任务后，worker 会通过后端内部 API 领取 `queued` 任务并执行本脚本。

本地运行：

```bash
uv run python scripts/story_generator_pipeline/queue_worker.py \
  --backend-url http://127.0.0.1:8787 \
  --worker-token dev-worker-token \
  --poll-seconds 2
```

常用环境变量：

- `STORY_GENERATOR_BACKEND_URL`
- `STORY_GENERATOR_WORKER_TOKEN`
- `STORY_GENERATOR_QUEUE_POLL_SECONDS`
- `STORY_GENERATOR_QUEUE_MAX_JOBS`
- `STORY_GENERATOR_QUEUE_PYTHON`

说明：worker 只负责消费队列并更新状态（`queued -> running -> succeeded/failed`），
日志与事件仍由 `generate_story.py` 的参数配置控制。

兼容说明：`--db/STORY_GENERATOR_QUEUE_DB_PATH` 仍可作为旧模式回退（不推荐），默认建议用 `--backend-url`。

向后兼容：历史变量名 `STORY_GENERATION_*` 仍然可用，但建议逐步迁移到 `STORY_GENERATOR_*`。

## 原子子命令（供 Node scene API 调用）

`atomic_cli.py` 提供三类子命令，输入 stdin JSON，输出 stdout JSON：

- `generate-text`：只生成场景文案与每个 scene 的 `image_prompt`
- `generate-image`：仅生成单个 scene 图片
- `generate-images`：批量生成多个 scene 图片

示例：

```bash
cat payload.json | python -m scripts.story_generator_pipeline.atomic_cli generate-text
cat payload.json | python -m scripts.story_generator_pipeline.atomic_cli generate-image
cat payload.json | python -m scripts.story_generator_pipeline.atomic_cli generate-images
```

该模式用于后端 `/api/runs/*` 原子化接口，Node 侧逐 scene 回写 SQLite，不再依赖 summary 全量同步。
