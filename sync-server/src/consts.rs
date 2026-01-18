use std::time::Duration;

use crate::utils::log_level::LogLevel;

pub const DEFAULT_CONFIG_PATH: &str = "config.yml";

pub const DEFAULT_DATABASES_DIRECTORY_PATH: &str = "databases";
pub const DEFAULT_MAX_CONNECTIONS_PER_VAULT: u32 = 12;
pub const DEFAULT_CURSOR_TIMEOUT: Duration = Duration::from_secs(60);

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 3000;
pub const DEFAULT_MAX_BODY_SIZE_MB: usize = 4096;
pub const DEFAULT_RESPONSE_TIMEOUT_SECONDS: Duration = Duration::from_mins(30);
pub const DEFAULT_MAX_CLIENTS_PER_VAULT: usize = 256;

pub const DEFAULT_LOG_DIRECTORY: &str = "logs";
pub const DEFAULT_LOG_ROTATION_INTERVAL: Duration = Duration::from_hours(24);
pub const IDLE_POOL_TIMEOUT: Duration = Duration::from_mins(5);
pub const DEFAULT_LOG_LEVEL: LogLevel = LogLevel::Info;

pub const DEFAULT_MERGEABLE_FILE_EXTENSIONS: &[&str] = &["md", "txt"];

pub const SUPPORTED_API_VERSION: u32 = 3;
