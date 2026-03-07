import { useRef, useState } from "react";

export function usePlayFlow() {
  const [playIndex, setPlayIndex] = useState(0);
  const [levelSeed, setLevelSeed] = useState(0);
  const [activeJumperLevelId, setActiveJumperLevelId] = useState<string>("");
  const [showMobileJumper, setShowMobileJumper] = useState(false);
  const [mobileJumperOffset, setMobileJumperOffset] = useState({ x: 0, y: 0 });

  const mobileJumperDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    baseOffsetX: number;
    baseOffsetY: number;
    moved: boolean;
  } | null>(null);

  return {
    activeJumperLevelId,
    levelSeed,
    mobileJumperDragRef,
    mobileJumperOffset,
    playIndex,
    setActiveJumperLevelId,
    setLevelSeed,
    setMobileJumperOffset,
    setPlayIndex,
    setShowMobileJumper,
    showMobileJumper,
  };
}
