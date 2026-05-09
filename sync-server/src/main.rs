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
use log::{error, info, warn};
use server::create_server;
use tracing_appender::non_blocking::WorkerGuard;
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
        Err(error) => {
            return exit_with_startup_error(&args, &error);
        }
    };

    if let Err(error) = config.validate().map_err(init_error) {
        return exit_with_startup_error(&args, &error);
    }

    // Hold the non-blocking writer guards until shutdown so the dedicated
    // writer threads stay alive and flush queued log lines.
    let _log_guards = match set_up_logging(&args, &config.logging) {
        Ok(log_guards) => log_guards,
        Err(error) => {
            return exit_with_startup_error(&args, &error);
        }
    };

    match start_server(config).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let serialized = error.serialize();
            warn!("{serialized}");
            ExitCode::FAILURE
        }
    }
}

fn exit_with_startup_error(args: &Args, err: &SyncServerError) -> ExitCode {
    let _ = set_up_stderr_logging(args);

    let serialized = err.serialize();
    error!("{serialized}");

    ExitCode::FAILURE
}

fn set_up_stderr_logging(args: &Args) -> Result<(), SyncServerError> {
    let env_filter = EnvFilter::builder()
        .with_default_directive(tracing::Level::WARN.into())
        .from_env()
        .context("Failed to create logging env filter")
        .map_err(init_error)?;

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_ansi(args.color.use_colors())
        .with_writer(std::io::stderr)
        .event_format(format().compact());

    tracing_subscriber::registry()
        .with(env_filter)
        .with(stderr_layer)
        .try_init()
        .context("Failed to initialise fallback tracing")
        .map_err(init_error)
}

fn set_up_logging(
    args: &Args,
    logging_config: &config::logging_config::LoggingConfig,
) -> Result<[WorkerGuard; 2], SyncServerError> {
    let level_filter = logging_config.log_level.as_tracing_level();

    let env_filter = EnvFilter::builder()
        .with_default_directive(level_filter.into())
        .from_env()
        .context("Failed to create logging env filter")
        .map_err(init_error)?;

    let use_colors = args.color.use_colors();

    let is_debug_mode = logging_config.log_level.is_debug_or_trace();

    let file_appender = RotatingFileWriter::new(
        &logging_config.log_directory,
        "vault-link",
        logging_config.log_rotation,
    )
    .context("Failed to create rotating file writer")
    .map_err(init_error)?;

    // Decouple log emission from disk/stderr I/O. Without this, a tokio
    // worker that holds the writer's std::sync::Mutex while a `write(2)`
    // is throttled by the kernel (e.g. btrfs writeback) cascades the
    // stall to every other worker that tries to log, freezing the whole
    // runtime. The guards must outlive every emitter.
    let (file_writer, file_guard) = tracing_appender::non_blocking(file_appender);
    let (stderr_writer, stderr_guard) = tracing_appender::non_blocking(std::io::stderr());

    let format = format()
        .with_target(is_debug_mode)
        .with_line_number(is_debug_mode)
        .compact();

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_ansi(use_colors)
        .with_writer(stderr_writer)
        .event_format(format.clone());

    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(file_writer)
        .event_format(format);

    tracing_subscriber::registry()
        .with(env_filter)
        .with(file_layer)
        .with(stderr_layer)
        .try_init()
        .context("Failed to initialise tracing")
        .map_err(init_error)?;

    Ok([file_guard, stderr_guard])
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
