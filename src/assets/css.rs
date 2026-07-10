use sha2::{Digest, Sha256};
use std::env;
use std::fs::File;
use std::io::Write;
use std::path::{self, Path};
use std::process::Command;

pub async fn build_css(
    output_dir: &Path,
    assets_dir: &Path,
    download_tailwind: bool,
    major_version: u8,
) -> Result<(), Box<dyn std::error::Error>> {
    let binary_path = if download_tailwind {
        download_tailwind_binary(assets_dir, major_version).await?
    } else {
        tailwind_path()?
    };

    eprintln!("Building CSS with Tailwind: {binary_path}");
    let output = Command::new(binary_path)
        .args([
            "--input",
            assets_dir.join("main.css").to_str().unwrap(),
            "--output",
            Path::new("./assets").join("dist.css").to_str().unwrap(),
            "--cwd",
            output_dir.to_str().unwrap(),
            "--minify",
        ])
        .output()?;
    std::io::stderr().write_all(&output.stderr)?;
    if !output.status.success() {
        panic!(
            "Tailwind failed to compile {}",
            assets_dir.join("main.css").display()
        );
    }

    Ok(())
}

/// Returns the path to execute the Tailwind binary.
///
/// If a `tailwindcss` binary already exists on the current path (determined
/// using `tailwindcss --help`), then the existing Tailwind is used. Otherwise,
/// a Tailwind binary is installed from GitHub releases into the user's cache
/// directory.
fn tailwind_path() -> Result<String, Box<dyn std::error::Error>> {
    let result = Command::new("tailwindcss").arg("--help").status();
    match result {
        Ok(status) if status.success() => Ok("tailwindcss".to_owned()),
        _ => Err("Could not find Tailwind binary".into()),
    }
}

pub async fn download_tailwind_binary(
    binary_path: &path::Path,
    major_version: u8,
) -> Result<String, Box<dyn std::error::Error>> {
    let (target, expected_sha256) = match (env::consts::OS, env::consts::ARCH) {
        ("linux", "x86_64") => (
            "linux-x64",
            "5036c4fb4328e0bcdbb6065c70d8ac9452e0d4c947113a788a8f94fd390425c1",
        ),
        ("linux", "aarch64") => (
            "linux-arm64",
            "394ddccc2402cfa3abd97dfba56f3587781a3d6e6ce66e65ceada14beb7664b8",
        ),
        ("macos", "x86_64") => (
            "macos-x64",
            "cef8f110471e889c3c4409055cf8aff33076f58a081867b0dfc6534b290bfbb0",
        ),
        ("macos", "aarch64") => (
            "macos-arm64",
            "b800b0659dc64b9f03ede5660244d9415d777d5739ae2889280877ca37be742a",
        ),
        ("windows", "x86_64") => (
            "windows-x64.exe",
            "224a62a8351d3b8da9d950a4eb1d7176dc901dc4735b47f816f3dfcbc67d8654",
        ),
        (os, arch) => {
            return Err(format!("Tailwind does not publish a binary for {os}/{arch}").into())
        }
    };
    let version_tag = match major_version {
        4 => "v4.3.2",
        _ => return Err(format!("Unsupported Tailwind major version: {major_version}").into()),
    };
    let binary_path = binary_path.join(format!("tailwindcss-{version_tag}-{target}"));
    if !binary_path.exists() {
        eprintln!("Downloading Tailwind {version_tag} binary to {binary_path:?}");
        let url = format!(
            "https://github.com/tailwindlabs/tailwindcss/releases/download/{version_tag}/tailwindcss-{target}"
        );
        let response = reqwest::get(&url).await?;
        if response.status().is_success() {
            let content = response.bytes().await?;
            verify_sha256(&content, expected_sha256)?;
            let mut file = File::create(&binary_path)?;
            file.write_all(&content)?;

            // On non-Windows platforms, we need to mark the file as executable
            #[cfg(target_family = "unix")]
            {
                use std::os::unix::prelude::PermissionsExt;
                let user_execute = std::fs::Permissions::from_mode(0o755);
                std::fs::set_permissions(&binary_path, user_execute)?;
            }
        } else {
            return Err(format!(
                "Failed to download Tailwind {version_tag} for {target}: {}",
                response.status()
            )
            .into());
        }
    } else {
        verify_sha256(&std::fs::read(&binary_path)?, expected_sha256)?;
        eprintln!("Tailwind binary already exists at {binary_path:?}");
    }

    Ok(binary_path.to_str().unwrap().to_owned())
}

fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), Box<dyn std::error::Error>> {
    let actual = Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if actual != expected {
        return Err(format!(
            "Tailwind binary checksum mismatch: expected {expected}, received {actual}"
        )
        .into());
    }
    Ok(())
}
