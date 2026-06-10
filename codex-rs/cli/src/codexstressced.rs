/// Codex Stressced Mode - llama.cpp Server Local AI Configuration
///
/// This module provides configuration validation and setup for codexstressced,
/// which is a completely isolated variant of Codex that:
/// - Uses ONLY llama.cpp server for local, offline AI inference
/// - Stores configuration in ~/.llmlocal (or custom directory) instead of ~/.codex
/// - Runs completely separately from the original codex.exe
/// - Provides automatic model detection and switching from llama.cpp server
use anyhow::anyhow;

/// Detects if the program is running as codexstressced
pub fn is_running_as_codexstressced() -> bool {
    #[cfg(feature = "stressced")]
    {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_owned()))
            .and_then(|n| n.to_str().map(|s| s.to_lowercase()))
            .map(|exe_name| exe_name.contains("codexstressced"))
            .unwrap_or(false)
    }
    #[cfg(not(feature = "stressced"))]
    {
        false
    }
}

/// Configures environment variables for complete isolation in codexstressced mode
pub fn setup_isolation(custom_config_dir: Option<&str>) -> anyhow::Result<()> {
    // Set CODEX_HOME to ensure we use .llmlocal or custom path
    if std::env::var("CODEX_HOME").is_err() {
        let home_dir = if let Ok(home) = std::env::var("HOME") {
            home
        } else if let Ok(userprofile) = std::env::var("USERPROFILE") {
            userprofile
        } else {
            return Err(anyhow!("Could not determine home directory"));
        };

        let codex_home = match custom_config_dir {
            Some(path) => path.to_string(),
            None => format!("{}/.llmlocal", home_dir),
        };

        unsafe {
            std::env::set_var("CODEX_HOME", &codex_home);
        }
    }

    // Set SQLite database directory for isolation
    if std::env::var("CODEX_SQLITE_HOME").is_err() {
        if let Ok(codex_home) = std::env::var("CODEX_HOME") {
            let sqlite_home = format!("{}/.sqlite", codex_home);
            unsafe {
                std::env::set_var("CODEX_SQLITE_HOME", &sqlite_home);
            }
        }
    }

    unsafe {
        std::env::set_var("CODEX_STRESSCED_MODE", "1");
    }

    Ok(())
}

/// Validates that only llama.cpp server provider is configured
/// Returns an error if any other provider is detected
pub fn validate_llama_cpp_only_mode(provider_config: &str) -> anyhow::Result<()> {
    // Check for non-llama.cpp providers in the config
    let forbidden_patterns = [
        (
            "openai",
            "OpenAI is not supported in codexstressced. Use only llama.cpp server.",
        ),
        (
            "bedrock",
            "AWS Bedrock is not supported in codexstressced. Use only llama.cpp server.",
        ),
        (
            "lmstudio",
            "LM Studio is not supported in codexstressced. Use only llama.cpp server.",
        ),
        (
            "gpt-4",
            "GPT models are not supported in codexstressced. Use only llama.cpp server.",
        ),
        (
            "claude",
            "Claude models are not supported in codexstressced. Use only llama.cpp server.",
        ),
        (
            "api_key",
            "API keys are not supported in codexstressced. Use only local llama.cpp server.",
        ),
    ];

    for (pattern, message) in &forbidden_patterns {
        if provider_config.to_lowercase().contains(pattern) {
            return Err(anyhow!("❌ {}", message));
        }
    }

    Ok(())
}

/// Validates that the configuration is compatible with codexstressced mode
/// This function ensures that only llama.cpp server providers are used in codexstressced mode
pub fn validate_config_for_stressced_mode(config_content: &str) -> anyhow::Result<()> {
    // Check for any model provider entries that are not llama.cpp server
    if config_content.to_lowercase().contains("[model_providers]") {
        // If there are model_providers defined, check that they're all llama.cpp server
        let lines: Vec<&str> = config_content.lines().collect();
        let mut in_model_providers_section = false;

        for line in &lines {
            if line.trim() == "[model_providers]" {
                in_model_providers_section = true;
                continue;
            }

            if in_model_providers_section {
                if line.trim().starts_with('[') {
                    // We've moved to another section
                    break;
                }

                // Check if this is a provider definition that's not llama.cpp server
                if line.trim().contains('=') && !line.trim().starts_with("llama_cpp") {
                    // This is a provider definition, check if it's llama.cpp server
                    if !line.trim().contains("llama_cpp") {
                        return Err(anyhow!(
                            "❌ codexstressced mode only supports llama.cpp server providers. \
                            Found non-llama.cpp provider definition in config."
                        ));
                    }
                }
            }
        }
    }

    Ok(())
}

/// Ensures llama.cpp server is accessible and returns available models
pub async fn check_llama_cpp_availability() -> anyhow::Result<Vec<String>> {
    let llama_cpp_endpoint =
        std::env::var("LLAMA_CPP_ENDPOINT").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string());

    // Try to connect to llama.cpp server
    let client = reqwest::Client::new();
    match client
        .get(format!("{}/v1/models", llama_cpp_endpoint))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            // Parse the JSON response to get model list
            match response.json::<serde_json::Value>().await {
                Ok(data) => {
                    let models: Vec<String> = data
                        .get("data")
                        .and_then(|m| m.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|m| {
                                    m.get("id").and_then(|n| n.as_str()).map(String::from)
                                })
                                .collect()
                        })
                        .unwrap_or_default();

                    if models.is_empty() {
                        eprintln!(
                            "⚠️ Warning: No models found in llama.cpp server. Please start the server and load a model."
                        );
                        eprintln!(
                            r"   Example: llama-b9412-bin-win-cuda-13.3-x64\llama-server.exe --model models\llama-2-7b-q4_0.gguf"
                        );
                    } else {
                        eprintln!(
                            "✅ Found {} llama.cpp server models available:",
                            models.len()
                        );
                        for model in &models {
                            eprintln!("   - {}", model);
                        }
                    }

                    Ok(models)
                }
                Err(_) => Err(anyhow!(
                    "Failed to parse llama.cpp server response. Make sure llama.cpp server is running on {}",
                    llama_cpp_endpoint
                )),
            }
        }
        Ok(response) => {
            let status = response.status();
            Err(anyhow!(
                "llama.cpp server is not accessible at {}. HTTP Status: {}. Please start llama.cpp server first.",
                llama_cpp_endpoint,
                status
            ))
        }
        Err(e) => Err(anyhow!(
            "Cannot connect to llama.cpp server at {}. Error: {}. Please start llama.cpp server first.",
            llama_cpp_endpoint,
            e
        )),
    }
}

/// Prints a banner showing codexstressced is active
pub fn print_banner() {
    eprintln!();
    eprintln!("╔════════════════════════════════════════════════════════════════╗");
    eprintln!("║         🤖 Codex Stressced - Local AI Offline Mode 🤖         ║");
    eprintln!("║                                                                ║");
    eprintln!("║  • Using ONLY llama.cpp server for local inference             ║");
    eprintln!("║  • Configuration: ~/.llmlocal/                                 ║");
    eprintln!("║  • Completely isolated from main Codex installation            ║");
    eprintln!("║  • No cloud connectivity required                              ║");
    eprintln!("╚════════════════════════════════════════════════════════════════╝");
    eprintln!();
}

/// Validates that only llama.cpp server provider is configured
/// Returns an error if any other provider is detected
pub fn validate_llama_cpp_only_config(provider_config: &str) -> anyhow::Result<()> {
    // Check for non-llama.cpp providers in the config
    let forbidden_patterns = [
        (
            "openai",
            "OpenAI is not supported in codexstressced. Use only llama.cpp server.",
        ),
        (
            "bedrock",
            "AWS Bedrock is not supported in codexstressced. Use only llama.cpp server.",
        ),
        (
            "lmstudio",
            "LM Studio is not supported in codexstressced. Use only llama.cpp server.",
        ),
        (
            "gpt-4",
            "GPT models are not supported in codexstressced. Use only llama.cpp server.",
        ),
        (
            "claude",
            "Claude models are not supported in codexstressced. Use only llama.cpp server.",
        ),
        (
            "api_key",
            "API keys are not supported in codexstressced. Use only local llama.cpp server.",
        ),
    ];

    for (pattern, message) in &forbidden_patterns {
        if provider_config.to_lowercase().contains(pattern) {
            return Err(anyhow!("❌ {}", message));
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_openai() {
        let result = validate_llama_cpp_only_config("provider = \"openai\"");
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .to_lowercase()
                .contains("openai")
        );
    }

    #[test]
    fn validate_rejects_bedrock() {
        let result = validate_llama_cpp_only_config("provider = \"bedrock\"");
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .to_lowercase()
                .contains("bedrock")
        );
    }

    #[test]
    fn validate_accepts_llama_cpp_config() {
        let result = validate_llama_cpp_only_config("provider = \"llama_cpp\"\nmodel = \"llama2\"");
        assert!(result.is_ok());
    }

    #[test]
    fn validate_rejects_api_key() {
        let result = validate_llama_cpp_only_config("api_key = \"sk-xxx\"");
        assert!(result.is_err());
    }
}
