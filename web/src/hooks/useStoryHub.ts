import { useRef, useState } from "react";

import { StoryDetail, StoryListItem } from "../core/types";

type TransitionPhase = "prepare" | "run";

type CoverRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type SharedCoverTransition = {
  storyId: string;
  coverSrc: string;
  from: CoverRect;
  to: CoverRect | null;
  phase: TransitionPhase;
};

export function useStoryHub() {
  const [stories, setStories] = useState<StoryListItem[]>([]);
  const [activeStory, setActiveStory] = useState<StoryDetail | null>(null);
  const [selectedBookKey, setSelectedBookKey] = useState("");
  const [openingStoryId, setOpeningStoryId] = useState<string | null>(null);
  const [sharedCover, setSharedCover] = useState<SharedCoverTransition | null>(null);
  const [hideDetailCover, setHideDetailCover] = useState(false);

  const storyCoverRefs = useRef<Record<string, HTMLImageElement | null>>({});
  const storyDetailCoverRef = useRef<HTMLImageElement | null>(null);

  return {
    activeStory,
    hideDetailCover,
    openingStoryId,
    selectedBookKey,
    setActiveStory,
    setHideDetailCover,
    setOpeningStoryId,
    setSelectedBookKey,
    setSharedCover,
    setStories,
    sharedCover,
    stories,
    storyCoverRefs,
    storyDetailCoverRef,
  };
}
