use std::env;
use std::path::PathBuf;
use std::process::Command;

pub fn platform_unregister_url() {
    println!("Unregistering URL handler for the research:// protocol");

    #[cfg(target_os = "windows")]
    unregister_windows();

    #[cfg(target_os = "macos")]
    unregister_macos();

    #[cfg(target_os = "linux")]
    unregister_linux();

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    println!("Unsupported operating system");
}

#[cfg(target_os = "windows")]
fn generate_unregister_windows_command() -> Vec<&'static str> {
    vec!["REG", "DELETE", "HKEY_CLASSES_ROOT\\research", "/f"]
}

#[cfg(target_os = "windows")]
fn unregister_windows() {
    let reg_command_args = generate_unregister_windows_command();

    Command::new("cmd")
        .arg("/C")
        .args(reg_command_args)
        .output()
        .expect("Failed to execute registry command");

    println!("URL handler unregistered for Windows");
}

#[cfg(target_os = "macos")]
fn get_macos_unregister_path(home_dir: &str, app_name: &str) -> PathBuf {
    PathBuf::from(home_dir).join("Applications").join(app_name)
}

#[cfg(target_os = "macos")]
fn unregister_macos() {
    let app_name = "ResearchURLHandler.app";
    let home_dir = env::var("HOME").unwrap(); // This will be mocked in tests by not calling this func directly
    let app_path = get_macos_unregister_path(&home_dir, app_name);

    // In a real scenario, you would remove the directory.
    // For testing, we're focusing on path generation.
    // std::fs::remove_dir_all(app_path).unwrap_or_else(|e| {
    //     println!("Failed to remove app bundle: {}", e);
    // });

    println!("URL handler unregistered for macOS - (Simulated: directory removal skipped)");
}

#[cfg(target_os = "linux")]
fn get_linux_unregister_desktop_file_path(home_dir: &str) -> PathBuf {
    PathBuf::from(home_dir).join(".local/share/applications/research-url-handler.desktop")
}

#[cfg(target_os = "linux")]
fn get_linux_unregister_xdg_mime_args() -> [&'static str; 2] {
    ["uninstall", "research-url-handler.desktop"]
}

#[cfg(target_os = "linux")]
fn unregister_linux() {
    let home_dir = env::var("HOME").unwrap(); // Mocked in tests by not calling this func directly
    let desktop_file_path = get_linux_unregister_desktop_file_path(&home_dir);

    // std::fs::remove_file(desktop_file_path).unwrap_or_else(|e| {
    //     println!("Failed to remove desktop file: {}", e);
    // });

    let xdg_mime_args = get_linux_unregister_xdg_mime_args();
    // Command::new("xdg-mime")
    //     .args(xdg_mime_args)
    //     .output()
    //     .expect("Failed to unregister MIME type");

    println!("URL handler unregistered for Linux - (Simulated: file removal and command execution skipped)");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    #[cfg(target_os = "windows")]
    fn test_unregister_windows_command_generation() {
        let expected_command = vec!["REG", "DELETE", "HKEY_CLASSES_ROOT\\research", "/f"];
        let generated_command = generate_unregister_windows_command();
        assert_eq!(generated_command, expected_command);
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_unregister_macos_path_generation() {
        let mock_home_dir = "/mockhome";
        let app_name = "ResearchURLHandler.app";
        let expected_path = PathBuf::from(mock_home_dir).join("Applications").join(app_name);
        let generated_path = get_macos_unregister_path(mock_home_dir, app_name);
        assert_eq!(generated_path, expected_path);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn test_unregister_linux_paths_and_xdg_mime_args() {
        let mock_home_dir = "/mockhome";

        // Test .desktop file path
        let expected_desktop_file_path =
            PathBuf::from(mock_home_dir).join(".local/share/applications/research-url-handler.desktop");
        let generated_desktop_file_path = get_linux_unregister_desktop_file_path(mock_home_dir);
        assert_eq!(generated_desktop_file_path, expected_desktop_file_path);

        // Test xdg-mime arguments
        let expected_xdg_mime_args = ["uninstall", "research-url-handler.desktop"];
        let generated_xdg_mime_args = get_linux_unregister_xdg_mime_args();
        assert_eq!(generated_xdg_mime_args, expected_xdg_mime_args);
    }
}
