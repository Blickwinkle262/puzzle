ALTER TABLE llm_user_profiles
  ADD COLUMN story_provider_id INTEGER REFERENCES llm_providers(id) ON DELETE SET NULL;

ALTER TABLE llm_user_profiles
  ADD COLUMN summary_provider_id INTEGER REFERENCES llm_providers(id) ON DELETE SET NULL;

ALTER TABLE llm_user_profiles
  ADD COLUMN text2image_provider_id INTEGER REFERENCES llm_providers(id) ON DELETE SET NULL;

UPDATE llm_user_profiles
SET story_provider_id = COALESCE(story_provider_id, provider_id)
WHERE provider_id IS NOT NULL;

UPDATE llm_user_profiles
SET summary_provider_id = COALESCE(summary_provider_id, story_provider_id, provider_id)
WHERE provider_id IS NOT NULL;

UPDATE llm_user_profiles
SET text2image_provider_id = COALESCE(text2image_provider_id, provider_id)
WHERE provider_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_llm_user_profiles_story_provider
  ON llm_user_profiles(story_provider_id);

CREATE INDEX IF NOT EXISTS idx_llm_user_profiles_summary_provider
  ON llm_user_profiles(summary_provider_id);

CREATE INDEX IF NOT EXISTS idx_llm_user_profiles_image_provider
  ON llm_user_profiles(text2image_provider_id);
