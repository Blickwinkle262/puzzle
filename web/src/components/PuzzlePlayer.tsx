import { CSSProperties, PointerEvent, useEffect, useMemo, useRef, useState } from "react";

import {
  buildExpectedEdges,
  buildHiddenSides,
  buildPieces,
  createInitialPieceCells,
  groupForPiece,
  isSolved,
  planSwapByDelta,
  recomputeLockedEdges,
} from "../core/puzzle";
import { Cell, LevelConfig, PieceDef } from "../core/types";
import { useImageSize } from "../hooks/useImageSize";
import { useWindowSize } from "../hooks/useWindowSize";

const AUTO_NEXT_LEVEL_DELAY_MS = 1200;
const CONTINUE_SECONDS = 60;
const MAX_CONTINUE_COUNT = 3;

type Orientation = "portrait" | "landscape";

type PuzzlePlayerProps = {
  storyTitle: string;
  storyDescription: string;
  level: LevelConfig;
  levelIndex: number;
  totalLevels: number;
  currentCompleted: boolean;
  completedCount: number;
  allCompleted: boolean;
  canPrev: boolean;
  canNext: boolean;
  onPrevLevel: () => void;
  onNextLevel: () => void;
  onJumpUnfinished: () => void;
  onBackToStory: () => void;
  onRestartLevel: () => void;
  onLevelSolved: (levelId: string, elapsedMs: number | null) => void;
  currentBestTimeMs?: number;
};

export function PuzzlePlayer(props: PuzzlePlayerProps): JSX.Element {
  const {
    storyTitle,
    storyDescription,
    level,
    levelIndex,
    totalLevels,
    currentCompleted,
    completedCount,
    allCompleted,
    canPrev,
    canNext,
    onPrevLevel,
    onNextLevel,
    onJumpUnfinished,
    onBackToStory,
    onRestartLevel,
    onLevelSolved,
    currentBestTimeMs,
  } = props;

  const { rows, cols } = level.grid;
  const timeLimitSec = level.time_limit_sec ?? 0;
  const timedMode = timeLimitSec > 0;

  const pieces = useMemo(() => buildPieces(rows, cols), [rows, cols]);
  const expectedEdges = useMemo(() => buildExpectedEdges(rows, cols), [rows, cols]);

  const [pieceCells, setPieceCells] = useState<Record<number, Cell>>(() =>
    createInitialPieceCells({ rows, cols, mode: level.shuffle?.mode, seed: level.shuffle?.seed }),
  );
  const [lockedEdges, setLockedEdges] = useState<Set<string>>(() => new Set());
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<number> | null>(null);
  const [animating, setAnimating] = useState(false);
  const [previewOffset, setPreviewOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [orientation, setOrientation] = useState<Orientation>(() =>
    window.innerWidth >= window.innerHeight ? "landscape" : "portrait",
  );
  const [remainingSec, setRemainingSec] = useState<number>(timeLimitSec);
  const [timedOut, setTimedOut] = useState(false);
  const [continueUsedCount, setContinueUsedCount] = useState(0);
  const [timeExtraSec, setTimeExtraSec] = useState(0);

  const windowSize = useWindowSize();
  const imageSize = useImageSize(level.source_image);
  const boardLayout = useMemo(
    () => computeBoardLayout({ rows, cols, windowWidth: windowSize.width, windowHeight: windowSize.height, imageSize }),
    [rows, cols, windowSize.width, windowSize.height, imageSize],
  );

  const hiddenSides = useMemo(
    () =>
      buildHiddenSides({
        pieceCount: pieces.length,
        lockedEdges,
        expectedEdges,
      }),
    [pieces.length, lockedEdges, expectedEdges],
  );

  const solved = isSolved(lockedEdges, expectedEdges);
  const hasNextLevel = levelIndex < totalLevels - 1;
  const remainingContinueCount = Math.max(0, MAX_CONTINUE_COUNT - continueUsedCount);

  const linkAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewRafRef = useRef<number | null>(null);
  const pendingPreviewRef = useRef<{ dx: number; dy: number } | null>(null);
  const solvedReportedRef = useRef(false);
  const levelStartAtMsRef = useRef<number>(Date.now());
  const dragRef = useRef<{ active: boolean; pointerId: number | null; startX: number; startY: number; moved: boolean }>({
    active: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false,
  });

  useEffect(() => {
    const initial = createInitialPieceCells({ rows, cols, mode: level.shuffle?.mode, seed: level.shuffle?.seed });
    setPieceCells(initial);
    setLockedEdges(
      recomputeLockedEdges({
        pieceCells: initial,
        expectedEdges,
      }),
    );
    setSelectedGroupIds(null);
    setPreviewOffset(null);
    setAnimating(false);
    solvedReportedRef.current = false;
    setRemainingSec(timeLimitSec);
    setTimedOut(false);
    setContinueUsedCount(0);
    setTimeExtraSec(0);
    levelStartAtMsRef.current = Date.now();

    pendingPreviewRef.current = null;
    if (previewRafRef.current !== null) {
      window.cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }
  }, [rows, cols, level.shuffle?.mode, level.shuffle?.seed, expectedEdges, timeLimitSec]);

  useEffect(
    () => () => {
      if (previewRafRef.current !== null) {
        window.cancelAnimationFrame(previewRafRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!timedMode || solved || timedOut) {
      return;
    }

    const timer = window.setInterval(() => {
      setRemainingSec((prev) => {
        if (prev <= 1) {
          setTimedOut(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [timedMode, solved, timedOut]);

  useEffect(() => {
    const path = level.audio?.piece_link;
    if (!path) {
      linkAudioRef.current = null;
      return;
    }
    const audio = new Audio(path);
    audio.preload = "auto";
    linkAudioRef.current = audio;
  }, [level.audio?.piece_link]);

  useEffect(() => {
    if (!solved || solvedReportedRef.current) {
      return;
    }

    solvedReportedRef.current = true;
    const elapsedMs = timedMode ? Math.max(0, Date.now() - levelStartAtMsRef.current) : null;
    onLevelSolved(level.id, elapsedMs);
  }, [level.id, onLevelSolved, solved, timedMode]);

  const handleContinue60s = (): void => {
    if (!timedMode || solved || continueUsedCount >= MAX_CONTINUE_COUNT) {
      return;
    }
    setRemainingSec((prev) => prev + CONTINUE_SECONDS);
    setTimeExtraSec((prev) => prev + CONTINUE_SECONDS);
    setTimedOut(false);
    setContinueUsedCount((prev) => prev + 1);
  };

  const bestTimeText = currentBestTimeMs && currentBestTimeMs > 0 ? formatDurationMs(currentBestTimeMs) : null;
  const timerClassName = !timedMode ? "timer" : remainingSec <= 10 ? "timer critical" : remainingSec <= 30 ? "timer warning" : "timer";

  useEffect(() => {
    if (!solved || !hasNextLevel) {
      return;
    }

    const timer = window.setTimeout(() => {
      onNextLevel();
    }, AUTO_NEXT_LEVEL_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [solved, hasNextLevel, onNextLevel]);

  useEffect(() => {
    const update = () => {
      setOrientation(window.innerWidth >= window.innerHeight ? "landscape" : "portrait");
    };

    update();
    window.addEventListener("resize", update);
    screen.orientation?.addEventListener?.("change", update);

    return () => {
      window.removeEventListener("resize", update);
      screen.orientation?.removeEventListener?.("change", update);
    };
  }, []);

  const computeFreshLockedEdges = (cells: Record<number, Cell>): Set<string> =>
    recomputeLockedEdges({
      pieceCells: cells,
      expectedEdges,
    });

  const refreshLockedForSelection = (): Set<string> => {
    const refreshed = computeFreshLockedEdges(pieceCells);
    setLockedEdges(refreshed);
    return refreshed;
  };

  const applyPlannedSwap = (plan: ReturnType<typeof planSwapByDelta>, lockBase: Set<string>): boolean => {
    if (!plan) {
      return false;
    }

    setSelectedGroupIds(null);
    setPreviewOffset(null);
    pendingPreviewRef.current = null;
    if (previewRafRef.current !== null) {
      window.cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }

    setAnimating(true);
    setPieceCells(plan.endCells);

    window.setTimeout(() => {
      const nextLocked = computeFreshLockedEdges(plan.endCells);
      const newLinks = Math.max(0, nextLocked.size - lockBase.size);
      setLockedEdges(nextLocked);

      if (newLinks > 0 && linkAudioRef.current) {
        linkAudioRef.current.currentTime = 0;
        void linkAudioRef.current.play().catch(() => {
          // Some browsers block autoplay.
        });
      }
      setAnimating(false);
    }, 190);

    return true;
  };

  const setPreviewOffsetSmooth = (dx: number, dy: number): void => {
    pendingPreviewRef.current = { dx, dy };
    if (previewRafRef.current !== null) {
      return;
    }

    previewRafRef.current = window.requestAnimationFrame(() => {
      previewRafRef.current = null;
      if (pendingPreviewRef.current) {
        setPreviewOffset(pendingPreviewRef.current);
      }
    });
  };

  const snapDeltaForGroup = (groupIds: Set<number>, offset: { dx: number; dy: number }): { row: number; col: number } => {
    const rounded = {
      col: Math.round(offset.dx / boardLayout.tileWidth),
      row: Math.round(offset.dy / boardLayout.tileHeight),
    };

    const cells = [...groupIds].map((id) => pieceCells[id]);
    const minRow = Math.min(...cells.map((c) => c.row));
    const maxRow = Math.max(...cells.map((c) => c.row));
    const minCol = Math.min(...cells.map((c) => c.col));
    const maxCol = Math.max(...cells.map((c) => c.col));

    const minDeltaRow = -minRow;
    const maxDeltaRow = rows - 1 - maxRow;
    const minDeltaCol = -minCol;
    const maxDeltaCol = cols - 1 - maxCol;

    return {
      row: Math.max(minDeltaRow, Math.min(maxDeltaRow, rounded.row)),
      col: Math.max(minDeltaCol, Math.min(maxDeltaCol, rounded.col)),
    };
  };

  const handlePiecePointerDown = (pieceId: number, event: PointerEvent<HTMLButtonElement>) => {
    if (animating || solved || timedOut) {
      return;
    }

    const refreshedLocked = refreshLockedForSelection();
    const clickedGroup = groupForPiece(pieceId, refreshedLocked, pieces.length);

    setSelectedGroupIds(clickedGroup);
    dragRef.current = {
      active: true,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };

    setPreviewOffset({ dx: 0, dy: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePiecePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setPreviewOffsetSmooth(dx, dy);

    if (dx * dx + dy * dy >= 25) {
      dragRef.current = {
        ...drag,
        moved: true,
      };
    }
  };

  const handlePiecePointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag.active || drag.pointerId !== event.pointerId) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    dragRef.current = {
      active: false,
      pointerId: null,
      startX: 0,
      startY: 0,
      moved: false,
    };

    pendingPreviewRef.current = null;
    if (previewRafRef.current !== null) {
      window.cancelAnimationFrame(previewRafRef.current);
      previewRafRef.current = null;
    }

    if (!selectedGroupIds) {
      setPreviewOffset(null);
      return;
    }

    if (!drag.moved) {
      setPreviewOffset(null);
      return;
    }

    const refreshedLocked = refreshLockedForSelection();
    const releaseOffset = {
      dx: event.clientX - drag.startX,
      dy: event.clientY - drag.startY,
    };

    const delta = snapDeltaForGroup(selectedGroupIds, releaseOffset);
    const plan = planSwapByDelta({
      firstIds: selectedGroupIds,
      deltaRow: delta.row,
      deltaCol: delta.col,
      pieceCells,
      rows,
      cols,
      requireFirstWithinBoard: true,
    });

    if (!plan) {
      setPreviewOffset(null);
      return;
    }

    applyPlannedSwap(plan, refreshedLocked);
  };

  const magnetPreviewCells = useMemo(() => {
    if (!selectedGroupIds || !previewOffset) {
      return [] as Cell[];
    }

    if (Math.abs(previewOffset.dx) < 4 && Math.abs(previewOffset.dy) < 4) {
      return [] as Cell[];
    }

    const delta = snapDeltaForGroup(selectedGroupIds, previewOffset);
    return [...selectedGroupIds].map((id) => {
      const base = pieceCells[id];
      return {
        row: base.row + delta.row,
        col: base.col + delta.col,
      };
    });
  }, [selectedGroupIds, previewOffset, pieceCells]);

  const preferredOrientation = level.mobile?.preferred_orientation;
  const orientationMismatch = preferredOrientation ? preferredOrientation !== orientation : false;
  const orientationHintText = level.mobile?.orientation_hint || "建议调整手机方向以获得更好体验";

  return (
    <div className="app-shell puzzle-shell">
      <header className="top-bar">
        <div className="top-main">
          <h1>{storyTitle}</h1>
          <p>{storyDescription}</p>

          <div className="chapter-nav">
            <button type="button" className="nav-btn" onClick={onBackToStory}>
              ← 返回故事
            </button>
            <button type="button" className="nav-btn" onClick={onPrevLevel} disabled={!canPrev}>
              上一关
            </button>
            <p className="chapter">
              第 {levelIndex + 1} / {totalLevels} 关 · {level.title}
              <span className={`level-state ${currentCompleted ? "done" : "todo"}`}>
                {currentCompleted ? "已完成" : "未完成"}
              </span>
            </p>
            <button type="button" className="nav-btn" onClick={onNextLevel} disabled={!canNext}>
              下一关
            </button>
          </div>

          <p className="chapter-desc">{level.description}</p>
          {level.story_text && <p className="story-inline">{level.story_text}</p>}
        </div>

        <div className="top-actions puzzle-status-card">
          {timedMode && <p className={timerClassName}>{formatClock(remainingSec)}</p>}
          {bestTimeText && <p className="progress-inline">个人最快 {bestTimeText}</p>}
          {timeExtraSec > 0 && <p className="progress-inline">已续时 +{timeExtraSec}s</p>}
          {timedMode && <p className="progress-inline">续时次数 {continueUsedCount}/{MAX_CONTINUE_COUNT}</p>}
          <button type="button" className="jump-btn" onClick={onJumpUnfinished}>
            {allCompleted ? "全部完成，回到第一关" : "跳到未完成"}
          </button>
          <div className="progress-dots" aria-label={`关卡进度 ${levelIndex + 1}/${totalLevels}`}>
            {Array.from({ length: totalLevels }).map((_, index) => {
              const done = index < levelIndex || (index === levelIndex && currentCompleted);
              const current = index === levelIndex && !currentCompleted;

              return <span key={`progress-dot-${index}`} className={`progress-dot ${done ? "done" : ""} ${current ? "current" : ""}`.trim()} />;
            })}
          </div>
          <p className="progress-inline">
            已完成 {completedCount}/{totalLevels}
          </p>
        </div>
      </header>

      {orientationMismatch && <div className="orientation-tip">{orientationHintText}</div>}

      <main className="board-wrap">
        <div className="wood-frame-shell">
          <div className="wood-frame">
            <div className="frame-inner-border">
              <span className="frame-nail frame-nail-tl" aria-hidden="true" />
              <span className="frame-nail frame-nail-tr" aria-hidden="true" />
              <span className="frame-nail frame-nail-bl" aria-hidden="true" />
              <span className="frame-nail frame-nail-br" aria-hidden="true" />

              <div
                className="board"
                style={{
                  width: boardLayout.boardWidth,
                  height: boardLayout.boardHeight,
                }}
              >
                <div
                  className="board-grid"
                  style={{
                    backgroundSize: `${boardLayout.tileWidth}px ${boardLayout.tileHeight}px`,
                  }}
                />

                {magnetPreviewCells.map((cell, index) => (
                  <div
                    key={`magnet-${index}-${cell.row}-${cell.col}`}
                    className="magnet-preview-cell"
                    style={{
                      width: boardLayout.tileWidth,
                      height: boardLayout.tileHeight,
                      transform: `translate(${cell.col * boardLayout.tileWidth}px, ${cell.row * boardLayout.tileHeight}px)`,
                    }}
                  />
                ))}

                {pieces.map((piece) => {
                  const cell = pieceCells[piece.id];
                  const hidden = hiddenSides.get(piece.id) ?? new Set();
                  const selected = selectedGroupIds?.has(piece.id) ?? false;

                  return (
                    <button
                      key={piece.id}
                      type="button"
                      className={`tile ${animating ? "is-animating" : ""}`}
                      style={tileStyle({
                        piece,
                        cell,
                        sourceImage: level.source_image,
                        boardWidth: boardLayout.boardWidth,
                        boardHeight: boardLayout.boardHeight,
                        tileWidth: boardLayout.tileWidth,
                        tileHeight: boardLayout.tileHeight,
                        hidden,
                        selected,
                        previewOffset: selected ? previewOffset : null,
                      })}
                      onPointerDown={(event) => handlePiecePointerDown(piece.id, event)}
                      onPointerMove={handlePiecePointerMove}
                      onPointerUp={handlePiecePointerUp}
                    />
                  );
                })}
              </div>
            </div>
          </div>
          <div className="frame-caption">木框拼图 · 网格 {rows} × {cols} · 第 {levelIndex + 1}/{totalLevels} 关</div>
        </div>

        <div className="hint">按住图块(组)直接拖拽，松手后交换；轻点仅高亮</div>
      </main>

      {timedOut && !solved && (
        <div className="mask">
          <div className="mask-card">
            <div>时间到</div>
            {remainingContinueCount > 0 ? (
              <>
                <div className="end-note">还可续时 {remainingContinueCount} 次（每次 {CONTINUE_SECONDS}s）</div>
                <div className="toolbar-row">
                  <button className="next-btn" type="button" onClick={handleContinue60s}>
                    续时 {CONTINUE_SECONDS}s（第 {continueUsedCount + 1}/{MAX_CONTINUE_COUNT} 次）
                  </button>
                  <button className="nav-btn" type="button" onClick={onRestartLevel}>
                    重新开始
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="end-note">本关超时，试试重新挑战</div>
                <button className="next-btn" type="button" onClick={onRestartLevel}>
                  重新开始
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {solved && (
        <div className="mask">
          <div className="mask-card">
            <div>{hasNextLevel ? "本关完成" : "该故事已完成"}</div>
            {hasNextLevel ? (
              <>
                <div className="next-note">即将进入下一关…</div>
                <button className="next-btn" type="button" onClick={onNextLevel}>
                  立即下一关
                </button>
              </>
            ) : (
              <>
                <div className="end-note">恭喜通关整个故事线</div>
                <button className="next-btn" type="button" onClick={onBackToStory}>
                  返回故事列表
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function formatClock(totalSeconds: number): string {
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  return `${mm}:${ss}`;
}

function formatDurationMs(totalMs: number): string {
  const safeMs = Math.max(0, Math.floor(totalMs));
  const totalSeconds = Math.floor(safeMs / 1000);
  const mm = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const ss = Math.floor(totalSeconds % 60)
    .toString()
    .padStart(2, "0");
  const cs = Math.floor((safeMs % 1000) / 10)
    .toString()
    .padStart(2, "0");
  return `${mm}:${ss}.${cs}`;
}

function tileStyle(opts: {
  piece: PieceDef;
  cell: Cell;
  sourceImage: string;
  boardWidth: number;
  boardHeight: number;
  tileWidth: number;
  tileHeight: number;
  hidden: Set<string>;
  selected: boolean;
  previewOffset: { dx: number; dy: number } | null;
}): CSSProperties {
  const {
    piece,
    cell,
    sourceImage,
    boardWidth,
    boardHeight,
    tileWidth,
    tileHeight,
    hidden,
    selected,
    previewOffset,
  } = opts;

  const borderColor = selected ? "#47e06a" : "rgba(255,255,255,0.9)";
  const borderWidth = 1;

  const previewDx = previewOffset?.dx ?? 0;
  const previewDy = previewOffset?.dy ?? 0;

  return {
    width: tileWidth,
    height: tileHeight,
    transform: `translate(${cell.col * tileWidth + previewDx}px, ${cell.row * tileHeight + previewDy}px)`,
    backgroundImage: `url(${sourceImage})`,
    backgroundSize: `${boardWidth}px ${boardHeight}px`,
    backgroundPosition: `${-piece.correctCol * tileWidth}px ${-piece.correctRow * tileHeight}px`,
    opacity: previewOffset ? 0.82 : 1,
    transition: previewOffset ? "none" : undefined,
    borderTop: hidden.has("top") ? "none" : `${borderWidth}px solid ${borderColor}`,
    borderRight: hidden.has("right") ? "none" : `${borderWidth}px solid ${borderColor}`,
    borderBottom: hidden.has("bottom") ? "none" : `${borderWidth}px solid ${borderColor}`,
    borderLeft: hidden.has("left") ? "none" : `${borderWidth}px solid ${borderColor}`,
  };
}

function computeBoardLayout(opts: {
  rows: number;
  cols: number;
  windowWidth: number;
  windowHeight: number;
  imageSize: { width: number; height: number; loaded: boolean };
}): {
  boardWidth: number;
  boardHeight: number;
  tileWidth: number;
  tileHeight: number;
} {
  const { rows, cols, windowWidth, windowHeight, imageSize } = opts;

  const sourceWidth = imageSize.loaded && imageSize.width > 0 ? imageSize.width : cols * 100;
  const sourceHeight = imageSize.loaded && imageSize.height > 0 ? imageSize.height : rows * 100;

  const maxWidth = Math.min(windowWidth - 28, 940);
  const maxHeight = Math.min(windowHeight - 260, 760);

  let boardWidth = maxWidth;
  let boardHeight = (boardWidth * sourceHeight) / sourceWidth;
  if (boardHeight > maxHeight) {
    boardHeight = maxHeight;
    boardWidth = (boardHeight * sourceWidth) / sourceHeight;
  }

  const tileWidth = Math.max(28, Math.floor(boardWidth / cols));
  const tileHeight = Math.max(28, Math.floor(boardHeight / rows));

  return {
    boardWidth: tileWidth * cols,
    boardHeight: tileHeight * rows,
    tileWidth,
    tileHeight,
  };
}
