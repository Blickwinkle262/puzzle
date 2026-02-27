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
web/public/content/stories/
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

默认端口 `http://localhost:5173`，并通过 Vite 代理把 `/api` 转发到后端。

## 内容索引约束

- `web/public/content/stories/index.json` 是**强约束主索引**，仅索引内的故事会被加载。
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

前端通过 `fetch(..., { credentials: "include" })` 自动携带会话 cookie。
前端在 `POST/PUT` 时会自动从 cookie 读取并携带固定 CSRF 头 `x-csrf-token`。
登录后前端会后台定时刷新会话并轮换 token，不会弹窗打断拼图流程。

## Docker 部署

### 一键启动（前后端 + SQLite）

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

### Docker 文件说明

- `backend/Dockerfile`：Node + Express + SQLite 后端镜像
- `web/Dockerfile`：Vite 构建前端 + Nginx 静态托管
- `deploy/nginx/default.conf`：前端路由回退 + `/api` 反向代理到 backend
- `docker-compose.yml`：编排 web/backend，挂载 `sqlite_data` 持久化数据库

## CI/CD

- `.github/workflows/ci.yml`
  - 构建前端
  - 校验后端语法
- `.github/workflows/cd.yml`
  - main 分支构建发布产物（web dist + backend）并上传 artifact
