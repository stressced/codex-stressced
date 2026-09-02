use async_trait::async_trait;
use codex_models_manager::manager::ModelCatalogMode;
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
    fn catalog_mode(&self) -> ModelCatalogMode {
        ModelCatalogMode::RemoteOnly
    }

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
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        // llama.cpp serves models at /v1/models (OpenAI-compatible).
        // The base_url already includes /v1, so append /models.
        let base_url = base_url.trim_end_matches('/');
        let url = format!("{base_url}/models");

        let resp = client
            .get(&url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| codex_protocol::error::CodexErr::Io(std::io::Error::other(err)))?;
        let val = resp
            .json::<JsonValue>()
            .await
            .map_err(|err| codex_protocol::error::CodexErr::Io(std::io::Error::other(err)))?;
        let data = val
            .get("data")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| {
                codex_protocol::error::CodexErr::Io(std::io::Error::other(
                    "llama.cpp models response is missing data",
                ))
            })?;
        let model_names = data
            .iter()
            .filter_map(|model| model.get("id").and_then(JsonValue::as_str));

        let mut models = Vec::new();
        for name in model_names {
            let mut info = model_info_from_slug(name);
            info.display_name = name.to_string();
            info.slug = name.to_string();
            // A local alias does not inherit OpenAI-specific reasoning controls.
            info.supported_reasoning_levels.clear();
            info.default_reasoning_level = None;
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

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use wiremock::Mock;
    use wiremock::MockServer;
    use wiremock::ResponseTemplate;
    use wiremock::matchers::path;

    #[tokio::test]
    async fn local_alias_does_not_advertise_openai_reasoning_controls() {
        let server = MockServer::start().await;
        Mock::given(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"id": "gpt-5.4"}]
            })))
            .mount(&server)
            .await;
        let endpoint = LlamaCppModelsEndpoint::new(Some(format!("{}/v1/", server.uri())));
        let (models, etag) = endpoint.list_models("test").await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].slug, "gpt-5.4");
        assert_eq!(models[0].default_reasoning_level, None);
        assert_eq!(models[0].supported_reasoning_levels, Vec::new());
        assert_eq!(etag, None);
    }

    #[tokio::test]
    async fn failed_catalog_fetch_is_an_error_instead_of_an_empty_success() {
        let server = MockServer::start().await;
        Mock::given(path("/v1/models"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        let endpoint = LlamaCppModelsEndpoint::new(Some(format!("{}/v1", server.uri())));
        assert!(endpoint.list_models("test").await.is_err());
    }
}
