UPDATE admin_prompt_presets
SET system_prompt_text =
  CASE
    WHEN trim(system_prompt_text) = '' THEN system_prompt_text
    WHEN instr(system_prompt_text, '只输出合法 JSON，不要 markdown，不要解释文字。') > 0 THEN system_prompt_text
    ELSE rtrim(system_prompt_text) || '\n只输出合法 JSON，不要 markdown，不要解释文字。'
  END,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE trim(system_prompt_text) <> ''
  AND instr(system_prompt_text, '只输出合法 JSON，不要 markdown，不要解释文字。') = 0;
