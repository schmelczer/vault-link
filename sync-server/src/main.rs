mod app_state;
mod cli;
mod config;
mod consts;
mod errors;
mod server;
mod utils;

use std::{ffi::OsString, path::PathBuf, process::ExitCode};

use anyhow::{Context as _, Result};
use clap::Parser;
use cli::args::Args;
use config::Config;
use consts::DEFAULT_CONFIG_PATH;
use errors::{SyncServerError, init_error};
use log::info;
use server::create_server;
use tracing_subscriber::{EnvFilter, fmt::format, layer::SubscriberExt, util::SubscriberInitExt};
use utils::rotating_file_writer::RotatingFileWriter;

#[tokio::main]
async fn main() -> ExitCode {
    let args = Args::parse();

    let config_path = args
        .config_path
        .clone()
        .unwrap_or_else(|| OsString::from(DEFAULT_CONFIG_PATH));
    let path = PathBuf::from(config_path);

    let config = match Config::read_or_create(&path)
        .await
        .context("Failed to start server")
        .map_err(init_error)
    {
        Ok(config) => config,
        Err(e) => {
            eprintln!("{}", e.serialize());
            return ExitCode::FAILURE;
        }
    };

    let mut result = set_up_logging(&args, &config.logging);

    if result.is_ok() {
        result = start_server(config).await;
    }

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{}", e.serialize());
            ExitCode::FAILURE
        }
    }
}

fn set_up_logging(
    args: &Args,
    logging_config: &config::logging_config::LoggingConfig,
) -> Result<(), SyncServerError> {
    let level_filter = match args.verbose.log_level_filter() {
        // We don't want to allow disabling all logging
        log::LevelFilter::Off | log::LevelFilter::Error => tracing::Level::ERROR,
        log::LevelFilter::Warn => tracing::Level::WARN,
        log::LevelFilter::Info => tracing::Level::INFO,
        log::LevelFilter::Debug => tracing::Level::DEBUG,
        log::LevelFilter::Trace => tracing::Level::TRACE,
    };

    let env_filter = EnvFilter::builder()
        .with_default_directive(level_filter.into())
        .from_env()
        .context("Failed to create logging env filter")
        .map_err(init_error)?;

    let use_colors = args.color.use_colors();

    let is_debug_mode = args.verbose.log_level_filter() >= log::LevelFilter::Debug;

    let file_appender = RotatingFileWriter::new(
        &logging_config.log_directory,
        "vault-link",
        logging_config.log_rotation,
    )
    .context("Failed to create rotating file writer")
    .map_err(init_error)?;

    let format = format()
        .with_target(is_debug_mode)
        .with_line_number(is_debug_mode)
        .compact();

    let stdout_layer = tracing_subscriber::fmt::layer()
        .with_ansi(use_colors)
        .with_writer(std::io::stdout)
        .event_format(format.clone());

    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(file_appender)
        .event_format(format);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stdout_layer)
        .with(file_layer)
        .try_init()
        .context("Failed to initialise tracing")
        .map_err(init_error)?;

    Ok(())
}

async fn start_server(config: Config) -> Result<(), SyncServerError> {
    info!(
        "Starting VaultLink server version {}",
        env!("CARGO_PKG_VERSION")
    );

    create_server(config)
        .await
        .context("Failed to start server")
        .map_err(init_error)
}
