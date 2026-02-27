# Pygame Puzzle (layered architecture)

这是一个以关卡 JSON 驱动的拼图项目骨架，支持：

- 将图片切成 `n * m` 小块
- 支持两种初始布局：`grid_shuffle`（框内网格打乱）/ `random_scatter`（框外散落）
- 正确邻接时自动吸附并连成可整体拖动的大块
- 右键拆分某个块（移除该块与其他块的连接）
- 每关可配置：标题、描述、图源、BGM、SFX、倒计时
- 资源目录统一放在 `materials/source/`

## 分层结构

```text
src/puzzle_game/
  domain/        # Piece, Group, GameState, 图和连通分量
  rules/         # 吸附判定与策略（strict / lenient / mobile）
  application/   # 拖拽流程 + Command + 关卡运行流
  ui/            # pygame 输入和渲染
  infra/         # 配置读写、资源加载、关卡工厂
```

## 设计模式落地

- Composite: `Piece` 与 `Group` 都实现 `move(dx, dy)`
- Strategy: `StrictSnapStrategy` / `LenientSnapStrategy` / `MobileSnapStrategy`
- Command: `MoveCommand` / `MergeCommand` / `SplitCommand`
- Factory: `PuzzleStateFactory` 从图源构建 `GameState`

## 安装与运行（uv）

```bash
uv sync
PYTHONPATH=src uv run python src/main.py
```

默认启动会读取固定入口文件 `configs/game_entry.json`，你只需要改它的 `active_level` 就能切关。

```bash
PYTHONPATH=src uv run python src/main.py --entry configs/game_entry.json
```

## 操作

- 左键按住：拖动一个块（或已连接块）
- 左键释放：与落点块交换位置，并对移动组尝试吸附/连接
- 右键点击块：拆开该块与其他块的连接
- `R`：重开当前关
- `Esc`：退出

当 `shuffle.mode = "grid_shuffle"` 时，交互会切换为：

- 左键点第一个块（或连通组）进入绿色高亮选中
- 左键点第二个块（或连通组）触发交换动画
- 若选中组交换后会越出拼图区网格，交换会被拒绝

## 当前默认关卡

- `levels/level_001.json`：`6 x 6`
- 图源：`materials/source/images/test.jpeg`
- 拼接成功音效：`materials/source/music/attach.mp3`（用于 `piece_link`）

## 规则配置示例

`configs/game_defaults.json` 或每关 `levels/*.json` 支持：

```json
{
  "rules": {
    "snap_strategy": "lenient",
    "magnet_strength": 0.35
  }
}
```

- `snap_strategy`: `strict` / `lenient` / `mobile`
- `magnet_strength`: 0.0 ~ 1.0
- `shuffle.mode`: `grid_shuffle` / `random_scatter`

## 资源说明

- 示例关卡引用：
  - `materials/source/images/demo_puzzle.jpg`
  - `materials/source/music/demo_bgm.ogg`
  - `materials/source/sfx/*.wav`
- 文件不存在时自动回退：
  - 图片：生成占位拼图图
  - 音频：静默（不报错退出）
