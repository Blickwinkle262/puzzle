import { useState } from "react";

import { PublishSuccessState, ScenePreviewState } from "./shared";

export function useAdminPublishState() {
  const [scenePreview, setScenePreview] = useState<ScenePreviewState | null>(null);
  const [publishSuccess, setPublishSuccess] = useState<PublishSuccessState | null>(null);

  return {
    publishSuccess,
    scenePreview,
    setPublishSuccess,
    setScenePreview,
  };
}
