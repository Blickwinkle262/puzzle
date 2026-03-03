# Puzzle Web + Backend

Web 端使用 React + Vite，后端使用 Node + Express + SQLite。

## 功能

- 用户注册/登录
- 认证使用后端 `httpOnly` cookie session（前端不存 token）
- 写操作启用 CSRF 防护（`x-csrf-token` 与会话绑定校验）
- 登录后进入故事导航（多故事 cover 卡片）
- 故事详情页查看所有关卡
- 拼图过程自动上报关卡进度（进行中/已完成）
- 本地 SQLite 持久化用户进度

## 目录约定

```text
backend/data/generated/content/stories/
  index.json
  <story-id>/
    story.json
    cover.jpg
    images/
    music/
    sfx/
```

你只需要改 `index.json` 和每个故事目录的 `story.json` 即可扩展内容。

## 本地运行

### 一行命令同时启动前后端

在项目根目录执行：

```bash
bash scripts/dev-all.sh
```

这个命令会自动安装前后端依赖并同时启动两个服务。

### 1) 启动后端

```bash
cd backend
npm install
npm run dev
```

默认端口 `http://localhost:8787`。

### 2) 启动前端

```bash
cd web
npm install
npm run dev
```

默认端口 `http://localhost:5173`，并通过 Vite 代理把 `/api` 与 `/content/stories` 转发到后端。

## 内容索引约束

- `backend/data/generated/content/stories/index.json` 是**强约束主索引**，仅索引内的故事会被加载。
- 每个条目必须有唯一 `id` 和有效 `manifest`。
- 索引内的 `manifest` 文件缺失或 JSON 非法会导致故事接口报错（故意 fail-fast，避免线上静默错配）。

## 会话并发策略

- 同一账号仅允许一个有效会话（单设备登录）。
- 新设备登录会自动使旧设备会话失效。

## API 概览

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/refresh`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/stories`
- `GET /api/stories/:storyId`
- `PUT /api/progress/levels/:levelId`
- `GET /api/admin/book-chapters`（管理员筛选书籍章节）
- `POST /api/admin/generate-story`（管理员触发生成，支持 `chapter_id`）
- `GET /api/admin/generate-story`（管理员查看任务列表）
- `GET /api/admin/generate-story/:runId`（管理员查看单任务状态与进度事件）

前端通过 `fetch(..., { credentials: "include" })` 自动携带会话 cookie。
前端在 `POST/PUT` 时会自动从 cookie 读取并携带固定 CSRF 头 `x-csrf-token`。
登录后前端会后台定时刷新会话并轮换 token，不会弹窗打断拼图流程。

## Docker 部署

### 一键启动（前端 + API + worker + SQLite）

在项目根目录执行：

```bash
cp .env.docker.example .env
docker compose up --build -d
```

访问：`http://<服务器IP>:8080`

### 关键配置项

- `WEB_PORT`：宿主机暴露端口（默认 `8080`）
- `COOKIE_SECURE`：
  - `true`：只在 HTTPS 下发送登录 cookie（生产建议）
  - `false`：允许 HTTP（本地/内网调试）
- `COOKIE_SAME_SITE`：`Lax` / `Strict` / `None`（`None` 需要 `COOKIE_SECURE=true`）
- `SESSION_TTL_DAYS`：登录会话有效天数
- `AIHUBMIX_API_KEY`：worker 执行生成任务时使用
- `STORY_GENERATOR_QUEUE_POLL_SECONDS`：worker 拉取队列频率（秒）
- `MAX_GENERATION_JOBS`：后端保留的历史任务上限

### Docker 文件说明

- `backend/Dockerfile`：Node + Express + SQLite API 镜像（不内置 Python）
- `deploy/worker/Dockerfile`：Python + uv 任务 worker 镜像（消费 generation_jobs 队列）
- `web/Dockerfile`：Vite 构建前端 + Nginx 静态托管
- `deploy/nginx/default.conf`：前端路由回退 + `/api` 反向代理到 backend
- `docker-compose.yml`：编排 web/backend/worker，挂载 `sqlite_data` 共享数据库和生成资源

## CI/CD

- `.github/workflows/ci.yml`
  - 构建前端
  - 校验后端语法
- `.github/workflows/cd.yml`
  - main 分支构建发布产物（web dist + backend）并上传 artifact


## 管理员触发生成示例

登录后（cookie 会话 + CSRF）可调用：

```bash
curl -X POST http://localhost:8787/api/admin/generate-story \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: <csrf-token>" \
  --cookie "puzzle_session=<session>; puzzle_csrf=<csrf>" \
  -d '{
    "target_date": "2026-03-03",
    "story_file": "scripts/book_ingest/output/chapter_2000.txt",
    "candidate_scenes": 12,
    "min_scenes": 10,
    "max_scenes": 12,
    "concurrency": 3
  }'
```

说明：该接口只负责创建 `queued` 任务；真正执行由独立 `worker` 容器完成。

可用这两个接口追踪状态：

- `GET /api/admin/generate-story`：列表
- `GET /api/admin/generate-story/:runId`：详情（含日志 tail 与 JSONL events）


## 管理员章节生成（前端）

- 故事首页会为管理员显示“章节生成”按钮
- 在面板中筛选章节后点击“开始生成”，任务进入 `queued`
- 前端每 2 秒轮询 `/api/admin/generate-story/:runId`，读取 `events` + `log_tail` 展示进度
- 状态到 `succeeded` 后自动刷新故事首页，新的 story 会立即出现在书架
