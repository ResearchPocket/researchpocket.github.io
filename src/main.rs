use clap::Parser;
use std::process::ExitCode;

use cli::CliArgs;

mod capture;
mod cli;
mod enrichment;
mod sync;
mod tui;
mod v2;

#[tokio::main]
async fn main() -> ExitCode {
    #[cfg(target_os = "macos")]
    if capture::macos_handler_launch_requested() {
        return match capture::run_macos_handler() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("error: {error}");
                ExitCode::FAILURE
            }
        };
    }

    match v2::handle(&CliArgs::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
