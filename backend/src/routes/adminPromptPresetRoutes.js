function normalizePresetName(value) {
  return String(value || "").trim().slice(0, 120);
}

function normalizePromptText(value, maxLength, fieldName) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${fieldName} 必须是字符串`);
  }

  const normalized = value.replace(/\r\n/g, "\n");
  if (normalized.length > maxLength) {
    throw new Error(`${fieldName} 过长（上限 ${maxLength} 字符）`);
  }
  return normalized;
}

function serializePromptPreset(row) {
  return {
    id: Number(row?.id || 0),
    name: String(row?.name || ""),
    system_prompt_text: String(row?.system_prompt_text || ""),
    user_prompt_template_text: String(row?.user_prompt_template_text || ""),
    image_prompt_suffix_text: String(row?.image_prompt_suffix_text || ""),
    is_builtin: Number(row?.is_builtin || 0) === 1,
    created_by_user_id: row?.created_by_user_id === null || row?.created_by_user_id === undefined
      ? null
      : Number(row.created_by_user_id),
    updated_by_user_id: row?.updated_by_user_id === null || row?.updated_by_user_id === undefined
      ? null
      : Number(row.updated_by_user_id),
    created_at: String(row?.created_at || ""),
    updated_at: String(row?.updated_at || ""),
  };
}

function isUniqueConstraintError(error) {
  const message = error instanceof Error ? error.message : "";
  return message.includes("UNIQUE constraint failed") || message.includes("constraint failed");
}

export function registerAdminPromptPresetRoutes(app, deps) {
  const {
    asMessage,
    db,
    normalizePositiveInteger,
    nowIso,
    requireAdmin,
    requireAuth,
    requireCsrf,
  } = deps;

  app.get("/api/admin/prompt-presets", requireAuth, requireAdmin, (_req, res) => {
    try {
      const rows = db
        .prepare(
          `
          SELECT
            id,
            name,
            system_prompt_text,
            user_prompt_template_text,
            image_prompt_suffix_text,
            is_builtin,
            created_by_user_id,
            updated_by_user_id,
            created_at,
            updated_at
          FROM admin_prompt_presets
          ORDER BY is_builtin DESC, updated_at DESC, id DESC
        `,
        )
        .all();

      res.json({
        ok: true,
        presets: rows.map((row) => serializePromptPreset(row)),
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "读取 Prompt 预设失败") });
    }
  });

  app.post("/api/admin/prompt-presets", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const name = normalizePresetName(req.body?.name);
    if (!name) {
      res.status(400).json({ message: "name 不能为空" });
      return;
    }

    let systemPromptText = "";
    let userPromptTemplateText = "";
    let imagePromptSuffixText = "";
    try {
      systemPromptText = normalizePromptText(req.body?.system_prompt_text, 120000, "system_prompt_text") || "";
      userPromptTemplateText = normalizePromptText(req.body?.user_prompt_template_text, 200000, "user_prompt_template_text") || "";
      imagePromptSuffixText = normalizePromptText(req.body?.image_prompt_suffix_text, 60000, "image_prompt_suffix_text") || "";
      if (userPromptTemplateText.trim() && !userPromptTemplateText.includes("{{SOURCE_TEXT}}")) {
        res.status(400).json({ message: "user_prompt_template_text 必须包含 {{SOURCE_TEXT}}" });
        return;
      }
    } catch (error) {
      res.status(400).json({ message: asMessage(error, "Prompt 文本不合法") });
      return;
    }

    try {
      const now = nowIso();
      const result = db
        .prepare(
          `
          INSERT INTO admin_prompt_presets (
            name,
            system_prompt_text,
            user_prompt_template_text,
            image_prompt_suffix_text,
            is_builtin,
            created_by_user_id,
            updated_by_user_id,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
        `,
        )
        .run(
          name,
          systemPromptText,
          userPromptTemplateText,
          imagePromptSuffixText,
          req.authUser?.id || null,
          req.authUser?.id || null,
          now,
          now,
        );

      const created = db
        .prepare(
          `
          SELECT
            id,
            name,
            system_prompt_text,
            user_prompt_template_text,
            image_prompt_suffix_text,
            is_builtin,
            created_by_user_id,
            updated_by_user_id,
            created_at,
            updated_at
          FROM admin_prompt_presets
          WHERE id = ?
          LIMIT 1
        `,
        )
        .get(Number(result.lastInsertRowid || 0));

      res.status(201).json({
        ok: true,
        preset: serializePromptPreset(created),
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        res.status(409).json({ message: "同名 Prompt 预设已存在" });
        return;
      }
      res.status(500).json({ message: asMessage(error, "创建 Prompt 预设失败") });
    }
  });

  app.put("/api/admin/prompt-presets/:presetId", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const presetId = normalizePositiveInteger(req.params.presetId);
    if (!presetId) {
      res.status(400).json({ message: "preset_id 不合法" });
      return;
    }

    const nextName = req.body?.name === undefined ? undefined : normalizePresetName(req.body?.name);
    if (req.body?.name !== undefined && !nextName) {
      res.status(400).json({ message: "name 不能为空" });
      return;
    }

    let nextSystemPromptText;
    let nextUserPromptTemplateText;
    let nextImagePromptSuffixText;
    try {
      nextSystemPromptText = normalizePromptText(req.body?.system_prompt_text, 120000, "system_prompt_text");
      nextUserPromptTemplateText = normalizePromptText(req.body?.user_prompt_template_text, 200000, "user_prompt_template_text");
      nextImagePromptSuffixText = normalizePromptText(req.body?.image_prompt_suffix_text, 60000, "image_prompt_suffix_text");
      if (
        nextUserPromptTemplateText !== undefined
        && nextUserPromptTemplateText.trim()
        && !nextUserPromptTemplateText.includes("{{SOURCE_TEXT}}")
      ) {
        res.status(400).json({ message: "user_prompt_template_text 必须包含 {{SOURCE_TEXT}}" });
        return;
      }
    } catch (error) {
      res.status(400).json({ message: asMessage(error, "Prompt 文本不合法") });
      return;
    }

    const hasPatch = (
      nextName !== undefined
      || nextSystemPromptText !== undefined
      || nextUserPromptTemplateText !== undefined
      || nextImagePromptSuffixText !== undefined
    );
    if (!hasPatch) {
      res.status(400).json({ message: "至少提供一个可更新字段" });
      return;
    }

    try {
      const existing = db
        .prepare(
          `
          SELECT
            id,
            name,
            system_prompt_text,
            user_prompt_template_text,
            image_prompt_suffix_text,
            is_builtin,
            created_by_user_id,
            updated_by_user_id,
            created_at,
            updated_at
          FROM admin_prompt_presets
          WHERE id = ?
          LIMIT 1
        `,
        )
        .get(presetId);
      if (!existing) {
        res.status(404).json({ message: "Prompt 预设不存在" });
        return;
      }

      if (Number(existing.is_builtin || 0) === 1) {
        res.status(400).json({ message: "内置预设不可修改" });
        return;
      }

      const now = nowIso();
      db.prepare(
        `
        UPDATE admin_prompt_presets
        SET
          name = ?,
          system_prompt_text = ?,
          user_prompt_template_text = ?,
          image_prompt_suffix_text = ?,
          updated_by_user_id = ?,
          updated_at = ?
        WHERE id = ?
      `,
      ).run(
        nextName ?? String(existing.name || ""),
        nextSystemPromptText ?? String(existing.system_prompt_text || ""),
        nextUserPromptTemplateText ?? String(existing.user_prompt_template_text || ""),
        nextImagePromptSuffixText ?? String(existing.image_prompt_suffix_text || ""),
        req.authUser?.id || null,
        now,
        presetId,
      );

      const updated = db
        .prepare(
          `
          SELECT
            id,
            name,
            system_prompt_text,
            user_prompt_template_text,
            image_prompt_suffix_text,
            is_builtin,
            created_by_user_id,
            updated_by_user_id,
            created_at,
            updated_at
          FROM admin_prompt_presets
          WHERE id = ?
          LIMIT 1
        `,
        )
        .get(presetId);

      res.json({
        ok: true,
        preset: serializePromptPreset(updated),
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        res.status(409).json({ message: "同名 Prompt 预设已存在" });
        return;
      }
      res.status(500).json({ message: asMessage(error, "更新 Prompt 预设失败") });
    }
  });

  app.delete("/api/admin/prompt-presets/:presetId", requireAuth, requireCsrf, requireAdmin, (req, res) => {
    const presetId = normalizePositiveInteger(req.params.presetId);
    if (!presetId) {
      res.status(400).json({ message: "preset_id 不合法" });
      return;
    }

    try {
      const existing = db
        .prepare("SELECT id, is_builtin FROM admin_prompt_presets WHERE id = ? LIMIT 1")
        .get(presetId);
      if (!existing) {
        res.status(404).json({ message: "Prompt 预设不存在" });
        return;
      }

      if (Number(existing.is_builtin || 0) === 1) {
        res.status(400).json({ message: "内置预设不可删除" });
        return;
      }

      db.prepare("DELETE FROM admin_prompt_presets WHERE id = ?").run(presetId);
      res.json({
        ok: true,
        deleted_preset_id: presetId,
      });
    } catch (error) {
      res.status(500).json({ message: asMessage(error, "删除 Prompt 预设失败") });
    }
  });
}
