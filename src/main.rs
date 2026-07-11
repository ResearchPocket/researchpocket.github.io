use clap::Parser;
use std::process::ExitCode;

use cli::CliArgs;

mod cli;
mod sync;
mod v2;

#[tokio::main]
async fn main() -> ExitCode {
    match v2::handle(&CliArgs::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}
