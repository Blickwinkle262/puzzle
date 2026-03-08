import { PuzzlePlayer } from "../components/PuzzlePlayer";
import { StoryDetail } from "../core/types";

type PlayPageProps = {
  activeStory: StoryDetail;
  allCompleted: boolean;
  completedCount: number;
  completedMap: Record<string, boolean>;
  currentLevel: StoryDetail["levels"][number];
  levelSeed: number;
  playIndex: number;
  totalLevels: number;
  onBackToStory: () => void;
  onJumpUnfinished: () => void;
  onLevelSolved: (levelId: string, elapsedMs: number | null, countAsCompleted: boolean) => void;
  onNextLevel: () => void;
  onPrevLevel: () => void;
  onRestartLevel: () => void;
};

export function PlayPage({
  activeStory,
  allCompleted,
  completedCount,
  completedMap,
  currentLevel,
  levelSeed,
  playIndex,
  totalLevels,
  onBackToStory,
  onJumpUnfinished,
  onLevelSolved,
  onNextLevel,
  onPrevLevel,
  onRestartLevel,
}: PlayPageProps): JSX.Element {
  return (
    <PuzzlePlayer
      key={`${activeStory.id}-${currentLevel.id}-${levelSeed}`}
      storyTitle={activeStory.title}
      storyDescription={activeStory.description}
      level={currentLevel}
      levelIndex={playIndex}
      totalLevels={totalLevels}
      currentCompleted={Boolean(completedMap[currentLevel.id])}
      currentBestTimeMs={activeStory.level_progress[currentLevel.id]?.best_time_ms}
      completedCount={completedCount}
      allCompleted={allCompleted}
      canPrev={playIndex > 0}
      canNext={playIndex < totalLevels - 1}
      onBackToStory={onBackToStory}
      onRestartLevel={onRestartLevel}
      onPrevLevel={onPrevLevel}
      onNextLevel={onNextLevel}
      onJumpUnfinished={onJumpUnfinished}
      onLevelSolved={onLevelSolved}
    />
  );
}
