use std::time::Duration;

use log::debug;
use serde::{Deserialize, Serialize};

use crate::{
    consts::{DEFAULT_LOG_DIRECTORY, DEFAULT_LOG_LEVEL, DEFAULT_LOG_ROTATION_INTERVAL},
    utils::log_level::LogLevel,
};

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct LoggingConfig {
    #[serde(default = "default_log_directory")]
    pub log_directory: String,

    #[serde(default = "default_log_rotation", with = "humantime_serde")]
    pub log_rotation: Duration,

    #[serde(default = "default_log_level")]
    pub log_level: LogLevel,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            log_directory: default_log_directory(),
            log_rotation: default_log_rotation(),
            log_level: default_log_level(),
        }
    }
}

fn default_log_directory() -> String {
    debug!("Using default log directory: `{DEFAULT_LOG_DIRECTORY}`");
    DEFAULT_LOG_DIRECTORY.to_owned()
}

fn default_log_rotation() -> Duration {
    debug!("Using default log rotation: {DEFAULT_LOG_ROTATION_INTERVAL:?}");
    DEFAULT_LOG_ROTATION_INTERVAL
}

fn default_log_level() -> LogLevel {
    debug!("Using default log level: Info");
    DEFAULT_LOG_LEVEL
}
