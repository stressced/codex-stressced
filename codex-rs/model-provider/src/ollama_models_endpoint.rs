use async_trait::async_trait;
use codex_models_manager::manager::ModelsEndpointClient;
use codex_models_manager::model_info::model_info_from_slug;
use codex_protocol::error::Result as CoreResult;
use codex_protocol::openai_models::ModelInfo;
use codex_protocol::openai_models::ModelVisibility;
use serde_json::Value as JsonValue;

#[derive(Debug)]
pub(crate) struct OllamaModelsEndpoint {
    base_url: Option<String>,
}

impl OllamaModelsEndpoint {
    pub(crate) fn new(base_url: Option<String>) -> Self {
        Self { base_url }
    }
}

#[async_trait]
impl ModelsEndpointClient for OllamaModelsEndpoint {
    fn has_command_auth(&self) -> bool {
        // We return true so that the models manager considers this endpoint
        // capable of fetching remote models and doesn't short-circuit the refresh.
        true
    }

    async fn uses_codex_backend(&self) -> bool {
        false
    }

    async fn list_models(
        &self,
        _client_version: &str,
    ) -> CoreResult<(Vec<ModelInfo>, Option<String>)> {
        // Build the base_url or default to localhost:11434
        let base_url = self
            .base_url
            .clone()
            .unwrap_or_else(|| "http://localhost:11434".to_string());

        // The host_root should just be the base URL without /v1 if present
        let host_root = if base_url.ends_with("/v1") {
            base_url[..base_url.len() - 3].to_string()
        } else {
            base_url
        };

        let client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        let tags_url = format!("{}/api/tags", host_root.trim_end_matches('/'));

        let resp = client
            .get(&tags_url)
            .send()
            .await
            .map_err(|e: reqwest::Error| {
                codex_protocol::error::CodexErr::Io(std::io::Error::other(e.to_string()))
            })?;

        let mut model_names: Vec<String> = Vec::new();
        if resp.status().is_success() {
            if let Ok(val) = resp.json::<JsonValue>().await {
                if let Some(arr) = val.get("models").and_then(|m: &JsonValue| m.as_array()) {
                    for v in arr {
                        if let Some(name) = v.get("name").and_then(|n: &JsonValue| n.as_str()) {
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
            // Crucial: Set visibility to List so they show up in the TUI model picker
            info.visibility = ModelVisibility::List;
            info.used_fallback_model_metadata = false;
            models.push(info);
        }

        Ok((models, None))
    }
}
