/// Llama.cpp model management for codexstressced
/// Provides commands to list, select, and manage Llama.cpp models
use anyhow::anyhow;
use clap::Parser;
use clap::Subcommand;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Parser)]
pub struct LlamaCommand {
    #[command(subcommand)]
    pub subcommand: LlamaSubcommand,
}

#[derive(Debug, Subcommand)]
pub enum LlamaSubcommand {
    /// List available models in Llama.cpp server
    List,

    /// Set the default model for codexstressced
    Set {
        /// Model name to set as default
        model: String,
    },

    /// Show current model selection
    Current,

    /// Show Llama.cpp connection info
    Status,
}

/// Get the Llama.cpp endpoint URL from environment or use default
pub fn get_llama_endpoint() -> String {
    std::env::var("LLAMA_CPP_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string())
}

/// Get the config file path for storing selected model
pub fn get_model_config_path() -> anyhow::Result<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME") {
        let path = PathBuf::from(codex_home).join("llama_model.txt");
        Ok(path)
    } else {
        Err(anyhow!("CODEX_HOME not set"))
    }
}

/// Get the currently selected model from config file
pub fn get_selected_model() -> anyhow::Result<String> {
    match get_model_config_path() {
        Ok(path) => {
            if path.exists() {
                let model = fs::read_to_string(path)?.trim().to_string();
                if model.is_empty() {
                    Ok("default".to_string()) // Default model
                } else {
                    Ok(model)
                }
            } else {
                Ok("default".to_string()) // Default if no config
            }
        }
        Err(_) => Ok("default".to_string()),
    }
}

/// Set the selected model in config file
pub fn set_selected_model(model: &str) -> anyhow::Result<()> {
    let path = get_model_config_path()?;

    // Ensure directory exists
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    fs::write(path, model)?;
    Ok(())
}

/// Fetch list of available models from Llama.cpp server
pub async fn list_models() -> anyhow::Result<Vec<LlamaModel>> {
    let endpoint = get_llama_endpoint();
    let client = reqwest::Client::new();

    let response = client
        .get(format!("{}/v1/models", endpoint))
        .send()
        .await
        .map_err(|e| {
            anyhow!(
                "Failed to connect to Llama.cpp server at {}. Is it running? Error: {}",
                endpoint,
                e
            )
        })?;

    if !response.status().is_success() {
        return Err(anyhow!(
            "Llama.cpp API returned error: {}. Make sure Llama.cpp server is running at {}",
            response.status(),
            endpoint
        ));
    }

    let data = response.json::<serde_json::Value>().await?;

    let models: Vec<LlamaModel> = data
        .get("data")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(|n| n.as_str())?;
                    let created = m.get("created").and_then(|t| t.as_u64()).unwrap_or(0);

                    Some(LlamaModel {
                        id: id.to_string(),
                        created,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(models)
}

/// Model information from Llama.cpp
#[derive(Debug, Clone)]
pub struct LlamaModel {
    pub id: String,
    pub created: u64,
}
