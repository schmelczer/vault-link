use std::{ffi::OsString, io::IsTerminal};

use clap::{Parser, ValueEnum};
use clap_verbosity_flag::{InfoLevel, Verbosity};

use crate::cli::color_when::ColorWhen;

/// Server for backing the `VaultLink` plugin
#[derive(Parser, Debug)]
#[command(version, about, long_about = None)]
pub struct Args {
    #[arg(index = 1)]
    pub config_path: Option<OsString>,

    #[command(flatten)]
    pub verbose: Verbosity<InfoLevel>,

    #[arg(
            long,
            require_equals = true,
            value_name = "WHEN",
            num_args = 0..=1,
            default_value_t = ColorWhen::Auto,
            default_missing_value = "always",
            value_enum
        )]
    pub color: ColorWhen,
}
