# Book Ingest (EPUB/TXT -> SQLite)

这个子项目和 `story_generator_pipeline` 并行，职责是：

- 解析整本书（`txt` / `epub`）
- 拆成章节文本并统计字数（全量保留，不在入库时删数据）
- 写入 SQLite（含章节 `meta_json`）
- 维护章节使用记录，避免重复生成

`story_generator_pipeline` 继续只处理“单个故事文本 -> puzzle 生成”。

## 目录

```text
scripts/book_ingest/
  schema.sql
  storage.py
  parsers.py
  repository.py
  ingest.py
  select_chapter.py
```

## 共享 uv 环境

本项目与现有工程共用一个 uv 环境，不需要再拆独立虚拟环境。

```bash
uv sync
```

如果要解析 EPUB，请确保安装 `ebooklib`（已加入依赖）。

## 入库示例

```bash
uv run python -m scripts.book_ingest.ingest \
  --source materials/source/books/liaozhai.epub \
  --format epub \
  --genre 志怪 \
  --book-meta-json '{"era":"清","audience":"adult"}' \
  --chapter-meta-json '{"style_tags":["classical","mystery"]}'
```

TXT 同理：

```bash
uv run python -m scripts.book_ingest.ingest \
  --source materials/source/books/liaozhai.txt \
  --format txt \
  --genre 志怪
```

## 选章与使用记录

### 1) 预占一个可用章节（避免重复）

```bash
uv run python -m scripts.book_ingest.select_chapter reserve \
  --usage-type puzzle_story \
  --reserve-minutes 30 \
  --min-chars 400 \
  --genre 志怪 \
  --with-text
```

默认会过滤 `meta_json.is_toc_like=true` 的目录残留章节；如需包含可加：

```bash
uv run python -m scripts.book_ingest.select_chapter reserve --include-toc-like
```

### 2) 生成成功后回写

```bash
uv run python -m scripts.book_ingest.select_chapter succeed \
  --usage-id 12 \
  --generated-story-id liaozhai-huapi-20260303 \
  --summary-path scripts/story_generator_pipeline/output/story_2026-03-03.json
```

### 3) 失败或释放

```bash
uv run python -m scripts.book_ingest.select_chapter fail --usage-id 12 --error-message "model timeout"
uv run python -m scripts.book_ingest.select_chapter release --usage-id 12 --error-message "manual release"
```

### 4) 查看章节是否已产出 story

```bash
uv run python -m scripts.book_ingest.select_chapter chapter-status --chapter-id 1001 --usage-type puzzle_story
```
