use async_trait::async_trait;
use codex_models_manager::manager::ModelsEndpointClient;
use codex_models_manager::model_info::model_info_from_slug;
use codex_protocol::error::Result as CoreResult;
use codex_protocol::openai_models::ModelInfo;
use codex_protocol::openai_models::ModelVisibility;
use codex_protocol::openai_models::TruncationPolicyConfig;
use serde_json::Value as JsonValue;

const DEFAULT_LLAMA_CPP_CONTEXT_WINDOW: i64 = 128_000;
const DEFAULT_LLAMA_CPP_TOOL_OUTPUT_TOKENS: i64 = 1_000;

/// Models endpoint that queries a llama.cpp server's OpenAI-compatible `/v1/models` API.
#[derive(Debug)]
pub(crate) struct LlamaCppModelsEndpoint {
    base_url: Option<String>,
}

impl LlamaCppModelsEndpoint {
    pub(crate) fn new(base_url: Option<String>) -> Self {
        Self { base_url }
    }
}

#[async_trait]
impl ModelsEndpointClient for LlamaCppModelsEndpoint {
    fn has_command_auth(&self) -> bool {
        // Return true so the models manager considers this endpoint capable of
        // fetching remote models and doesn't short-circuit the refresh.
        true
    }

    async fn uses_codex_backend(&self) -> bool {
        false
    }

    async fn list_models(
        &self,
        _client_version: &str,
    ) -> CoreResult<(Vec<ModelInfo>, Option<String>)> {
        let base_url = self
            .base_url
            .clone()
            .unwrap_or_else(|| "http://127.0.0.1:8080/v1".to_string());

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        // llama.cpp serves models at /v1/models (OpenAI-compatible).
        // The base_url already includes /v1, so append /models.
        let url = format!("{}/models", base_url.trim_end_matches('/'));

        let resp = client.get(&url).send().await.map_err(|e: reqwest::Error| {
            codex_protocol::error::CodexErr::Io(std::io::Error::other(e.to_string()))
        })?;

        let mut model_names: Vec<String> = Vec::new();
        if resp.status().is_success() {
            if let Ok(val) = resp.json::<JsonValue>().await {
                // llama.cpp returns { "data": [ { "id": "model-name", ... } ] }
                if let Some(arr) = val.get("data").and_then(|m: &JsonValue| m.as_array()) {
                    for v in arr {
                        if let Some(name) = v.get("id").and_then(|n: &JsonValue| n.as_str()) {
                            model_names.push(name.to_string());
                        }
                    }
                }
            }
        }

        let mut models = Vec::new();
        for name in model_names {
            let mut info = model_info_from_slug(&name);
            info.display_name = name.clone();
            info.slug = name;
            info.visibility = ModelVisibility::List;
            info.used_fallback_model_metadata = false;
            info.truncation_policy =
                TruncationPolicyConfig::tokens(DEFAULT_LLAMA_CPP_TOOL_OUTPUT_TOKENS);
            info.context_window = Some(DEFAULT_LLAMA_CPP_CONTEXT_WINDOW);
            info.max_context_window = None;
            info.auto_compact_token_limit =
                Some(DEFAULT_LLAMA_CPP_CONTEXT_WINDOW.saturating_mul(3) / 4);
            models.push(info);
        }

        Ok((models, None))
    }
}
