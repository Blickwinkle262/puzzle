import { useCallback, useEffect, useState } from "react";

import {
  apiGetAdminLevelConfig,
  apiPreviewAdminLevelConfig,
  apiRunAdminLevelTest,
  apiUpdateAdminLevelConfig,
} from "../../core/adminApi";
import { apiGetStoryDetail, apiListStories } from "../../core/api";
import {
  AdminLevelConfigResponse,
  AdminLevelTestRunResponse,
  StoryListItem,
} from "../../core/types";
import {
  buildLevelConfigPatch,
  defaultLevelConfigForm,
  errorMessage,
  formFromLevelConfig,
  type LevelConfigFormState,
} from "../../components/admin-story-generator/utils";

type LevelOption = {
  id: string;
  title: string;
};

type UseAdminLevelConfigCoordinatorOptions = {
  visible: boolean;
  setPanelError: (message: string) => void;
  setPanelInfo: (message: string) => void;
};

export function useAdminLevelConfigCoordinator({
  visible,
  setPanelError,
  setPanelInfo,
}: UseAdminLevelConfigCoordinatorOptions) {
  const [configStories, setConfigStories] = useState<StoryListItem[]>([]);
  const [configLevels, setConfigLevels] = useState<LevelOption[]>([]);

  const [loadingConfigCatalog, setLoadingConfigCatalog] = useState(false);
  const [loadingLevelConfig, setLoadingLevelConfig] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configPreviewing, setConfigPreviewing] = useState(false);
  const [configTesting, setConfigTesting] = useState(false);

  const [configStoryId, setConfigStoryId] = useState("");
  const [configLevelId, setConfigLevelId] = useState("");
  const [levelConfigSnapshot, setLevelConfigSnapshot] = useState<AdminLevelConfigResponse | null>(null);
  const [testRunResult, setTestRunResult] = useState<AdminLevelTestRunResponse | null>(null);
  const [levelConfigForm, setLevelConfigForm] = useState<LevelConfigFormState>(defaultLevelConfigForm());

  const loadConfigStories = useCallback(async (): Promise<void> => {
    setLoadingConfigCatalog(true);

    try {
      const response = await apiListStories();
      const stories = response.stories || [];
      setConfigStories(stories);

      if (stories.length === 0) {
        setConfigStoryId("");
        setConfigLevelId("");
        setConfigLevels([]);
        setLevelConfigSnapshot(null);
        return;
      }

      if (!stories.some((item) => item.id === configStoryId)) {
        setConfigStoryId(stories[0].id);
      }
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingConfigCatalog(false);
    }
  }, [configStoryId, setPanelError]);

  const loadConfigLevels = useCallback(async (storyId: string): Promise<void> => {
    const targetStoryId = storyId.trim();
    if (!targetStoryId) {
      setConfigLevels([]);
      setConfigLevelId("");
      return;
    }

    setLoadingConfigCatalog(true);
    try {
      const detail = await apiGetStoryDetail(targetStoryId);
      const levelOptions = (detail.story?.levels || []).map((item) => ({
        id: item.id,
        title: item.title,
      }));

      setConfigLevels(levelOptions);
      if (levelOptions.length === 0) {
        setConfigLevelId("");
        setLevelConfigSnapshot(null);
        return;
      }

      if (!levelOptions.some((item) => item.id === configLevelId)) {
        setConfigLevelId(levelOptions[0].id);
      }
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingConfigCatalog(false);
    }
  }, [configLevelId, setPanelError]);

  const loadLevelConfig = useCallback(async (): Promise<void> => {
    if (!configStoryId || !configLevelId) {
      return;
    }

    setLoadingLevelConfig(true);
    setTestRunResult(null);
    try {
      const snapshot = await apiGetAdminLevelConfig(configStoryId, configLevelId);
      setLevelConfigSnapshot(snapshot);
      setLevelConfigForm(formFromLevelConfig(snapshot));
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setLoadingLevelConfig(false);
    }
  }, [configLevelId, configStoryId, setPanelError]);

  const handleConfigFormChange = useCallback((patch: Partial<LevelConfigFormState>): void => {
    setLevelConfigForm((prev) => ({
      ...prev,
      ...patch,
    }));
  }, []);

  const handlePreviewLevelConfig = useCallback(async (): Promise<void> => {
    if (!configStoryId || !configLevelId) {
      setPanelError("请先选择故事和关卡");
      return;
    }

    const parsed = buildLevelConfigPatch(levelConfigForm);
    if (!parsed.ok) {
      setPanelError(parsed.message || "配置参数不合法");
      return;
    }

    setConfigPreviewing(true);
    setPanelError("");
    setPanelInfo("");

    try {
      const snapshot = await apiPreviewAdminLevelConfig(configStoryId, configLevelId, parsed.patch || {});
      setLevelConfigSnapshot(snapshot);
      setPanelInfo("预览配置已更新（未落库）");
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setConfigPreviewing(false);
    }
  }, [configLevelId, configStoryId, levelConfigForm, setPanelError, setPanelInfo]);

  const handleSaveLevelConfig = useCallback(async (): Promise<void> => {
    if (!configStoryId || !configLevelId) {
      setPanelError("请先选择故事和关卡");
      return;
    }

    const parsed = buildLevelConfigPatch(levelConfigForm);
    if (!parsed.ok) {
      setPanelError(parsed.message || "配置参数不合法");
      return;
    }

    setConfigSaving(true);
    setPanelError("");
    setPanelInfo("");

    try {
      const snapshot = await apiUpdateAdminLevelConfig(configStoryId, configLevelId, parsed.patch || {});
      setLevelConfigSnapshot(snapshot);
      setLevelConfigForm(formFromLevelConfig(snapshot));
      setPanelInfo("关卡配置已保存");
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setConfigSaving(false);
    }
  }, [configLevelId, configStoryId, levelConfigForm, setPanelError, setPanelInfo]);

  const handleTestLevelConfig = useCallback(async (): Promise<void> => {
    if (!configStoryId || !configLevelId) {
      setPanelError("请先选择故事和关卡");
      return;
    }

    const parsed = buildLevelConfigPatch(levelConfigForm);
    if (!parsed.ok) {
      setPanelError(parsed.message || "配置参数不合法");
      return;
    }

    setConfigTesting(true);
    setPanelError("");
    setPanelInfo("");

    try {
      const result = await apiRunAdminLevelTest(configStoryId, configLevelId, parsed.patch || {});
      setTestRunResult(result);
      setLevelConfigSnapshot({
        ok: true,
        ...result.config,
      });
      setPanelInfo(`测试关卡已生成：${result.test_run_id}`);
    } catch (err) {
      setPanelError(errorMessage(err));
    } finally {
      setConfigTesting(false);
    }
  }, [configLevelId, configStoryId, levelConfigForm, setPanelError, setPanelInfo]);

  useEffect(() => {
    if (!visible || !configStoryId) {
      return;
    }

    void loadConfigLevels(configStoryId);
  }, [configStoryId, loadConfigLevels, visible]);

  useEffect(() => {
    if (!visible || !configStoryId || !configLevelId) {
      return;
    }

    void loadLevelConfig();
  }, [configLevelId, configStoryId, loadLevelConfig, visible]);

  return {
    configLevelId,
    configLevels,
    configPreviewing,
    configSaving,
    configStories,
    configStoryId,
    configTesting,
    handleConfigFormChange,
    handlePreviewLevelConfig,
    handleSaveLevelConfig,
    handleTestLevelConfig,
    levelConfigForm,
    levelConfigSnapshot,
    loadConfigStories,
    loadLevelConfig,
    loadingConfigCatalog,
    loadingLevelConfig,
    setConfigLevelId,
    setConfigStoryId,
    setLevelConfigSnapshot,
    setTestRunResult,
    testRunResult,
  };
}
