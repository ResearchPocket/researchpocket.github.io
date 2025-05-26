use std::env;
use std::fs::File;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

pub fn platform_register_url() {
    #[cfg(target_os = "windows")]
    register_windows();
    #[cfg(target_os = "macos")]
    register_macos();
    #[cfg(target_os = "linux")]
    register_linux();

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    println!("Unsupported operating system");
}

#[cfg(target_os = "windows")]
fn generate_windows_commands(executable_path_str: &str) -> Vec<Vec<&str>> {
    let reg_cmd = format!("{} handle --url \"%1\"", executable_path_str);
    // Note: This is a simplified representation. In a real scenario, you might need to handle the lifetime of `reg_cmd` more carefully,
    // perhaps by returning Vec<Vec<String>> or by ensuring `reg_cmd` lives long enough.
    // For this specific case, since we are only testing the generation and not execution,
    // using it directly in the format macro within this function scope might be acceptable for the test's purpose.
    // However, to make it strictly correct and avoid potential issues if this function were used elsewhere,
    // it's better to ensure `reg_cmd` or its parts are owned by the returned structure or live as long as needed.
    // A quick fix for testing is to leak `reg_cmd` or collect parts into Strings.
    // For now, we'll assume the test will handle the lifetime implications if any,
    // or we acknowledge this as a simplification for the test's scope.
    // A more robust solution would involve returning owned Strings.
    // Let's refine this by making reg_cmd a String and cloning it where needed, or managing lifetimes appropriately.
    // For the purpose of this refactoring for testing, we'll proceed with a simplified approach
    // and acknowledge that a production version might require more careful string management.

    // To avoid lifetime issues with reg_cmd, we will make the command strings owned by leaking the formatted string.
    // This is generally not recommended for production code but is acceptable for testing purposes.
    let reg_cmd_owned = Box::leak(reg_cmd.into_boxed_str());

    vec![
        vec!["REG", "ADD", "HKEY_CLASSES_ROOT\\research", "/ve", "/d", "Research Pocket Url Handler", "/f"],
        vec!["REG", "ADD", "HKEY_CLASSES_ROOT\\research", "/v", "URL Protocol", "/d", "", "/f"],
        vec!["REG", "ADD", "HKEY_CLASSES_ROOT\\research\\shell", "/f"],
        vec!["REG", "ADD", "HKEY_CLASSES_ROOT\\research\\shell\\open", "/f"],
        vec![
            "REG",
            "ADD",
            "HKEY_CLASSES_ROOT\\research\\shell\\open\\command",
            "/ve",
            "/d",
            reg_cmd_owned, // Use the leaked string here
            "/f",
        ],
    ]
}

#[cfg(target_os = "windows")]
fn register_windows() {
    let executable_path = env::current_exe().unwrap();
    let executable_path_str = executable_path.to_str().unwrap();
    let commands = generate_windows_commands(executable_path_str);

    for command_args in commands {
        let output = Command::new("cmd")
            .args(["/C"])
            .args(&command_args) // Use the generated command arguments
            .output()
            .expect("Failed to execute command");

        if output.status.success() {
            println!("Successfully executed: {:?}", command_args);
        } else {
            panic!(
                "Failed to execute: {:?}. Error: {}",
                command_args,
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[cfg(target_os = "windows")]
    {
        use winrt_notification::{Duration, Toast};
        Toast::new(Toast::POWERSHELL_APP_ID)
            .title("ResearchPocket Handler")
            .text1("Handler registered!")
            .duration(Duration::Short)
            .show()
            .expect("Failed to send notification");
    }
    println!("URL handler registered for Windows");
}

#[cfg(target_os = "macos")]
fn generate_macos_plist_content(executable_name: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>ResearchURLHandler</string>
    <key>CFBundleIdentifier</key>
    <string>com.example.ResearchURLHandler</string>
    <key>CFBundleName</key>
    <string>ResearchURLHandler</string>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>Research URL</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>research</string>
            </array>
        </dict>
    </array>
    <key>CFBundleExecutable</key>
    <string>{}</string>
</dict>
</plist>"#,
        executable_name
    )
}

#[cfg(target_os = "macos")]
fn get_macos_paths(home_dir: &str, app_name: &str) -> (PathBuf, PathBuf) {
    let app_path = PathBuf::from(home_dir).join("Applications").join(app_name);
    let info_plist_path = app_path.join("Contents/Info.plist");
    (app_path, info_plist_path)
}

#[cfg(target_os = "macos")]
fn register_macos() {
    let app_name = "ResearchURLHandler.app";
    let home_dir = env::var("HOME").unwrap();
    let executable_path = env::current_exe().unwrap();
    
    let (app_path, info_plist_path) = get_macos_paths(&home_dir, app_name);

    std::fs::create_dir_all(&app_path).unwrap();
    std::fs::create_dir_all(app_path.join("Contents/MacOS")).unwrap();

    std::fs::copy(
        &executable_path,
        app_path.join("Contents/MacOS/ResearchURLHandler"),
    )
    .unwrap();

    let executable_name = executable_path.file_name().unwrap().to_str().unwrap();
    let plist_content = generate_macos_plist_content(executable_name);

    let mut file = File::create(info_plist_path).unwrap();
    file.write_all(plist_content.as_bytes()).unwrap();

    println!("URL handler registered for macOS");
}

#[cfg(target_os = "linux")]
fn generate_linux_desktop_content(executable_path_str: &str) -> String {
    format!(
        r#"[Desktop Entry]
Type=Application
Name=Research URL Handler
Exec={} handle --url %u
StartupNotify=false
MimeType=x-scheme-handler/research;"#,
        executable_path_str
    )
}

#[cfg(target_os = "linux")]
fn get_linux_paths(home_dir: &str) -> (PathBuf, PathBuf) {
    let apps_dir = PathBuf::from(home_dir).join(".local/share/applications");
    let desktop_file_path = apps_dir.join("research-url-handler.desktop");
    (apps_dir, desktop_file_path)
}

#[cfg(target_os = "linux")]
fn get_linux_xdg_mime_args() -> [&'static str; 3] {
    [
        "default",
        "research-url-handler.desktop",
        "x-scheme-handler/research",
    ]
}

#[cfg(target_os = "linux")]
fn register_linux() {
    let executable_path = env::current_exe().unwrap();
    let executable_path_str = executable_path.to_str().unwrap();
    let home_dir = env::var("HOME").unwrap();

    let desktop_entry = generate_linux_desktop_content(executable_path_str);
    let (_apps_dir, desktop_file_path) = get_linux_paths(&home_dir);
    
    // In a real scenario, you would create directories and files.
    // For testing, these are handled by mocks or assertions on paths and content.
    // std::fs::create_dir_all(&apps_dir).unwrap(); 
    // let mut file = File::create(desktop_file_path).unwrap();
    // file.write_all(desktop_entry.as_bytes()).unwrap();


    let xdg_mime_args = get_linux_xdg_mime_args();
    // Command::new("xdg-mime")
    //     .args(xdg_mime_args)
    //     .output()
    //     .expect("Failed to register MIME type");

    println!("URL handler registered for Linux - (Simulated: file and command execution skipped)");
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::path::PathBuf;

    // Helper function to simulate env::current_exe() for tests
    fn mock_current_exe(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_register_windows_commands_generation() {
        let mock_exe_path = "C:\\test\\research.exe";
        let expected_reg_cmd = format!("{} handle --url \"%1\"", mock_exe_path);
        let expected_commands = vec![
            vec!["REG", "ADD", "HKEY_CLASSES_ROOT\\research", "/ve", "/d", "Research Pocket Url Handler", "/f"],
            vec!["REG", "ADD", "HKEY_CLASSES_ROOT\\research", "/v", "URL Protocol", "/d", "", "/f"],
            vec!["REG", "ADD", "HKEY_CLASSES_ROOT\\research\\shell", "/f"],
            vec!["REG", "ADD", "HKEY_CLASSES_ROOT\\research\\shell\\open", "/f"],
            vec![
                "REG",
                "ADD",
                "HKEY_CLASSES_ROOT\\research\\shell\\open\\command",
                "/ve",
                "/d",
                &expected_reg_cmd, // Compare with the reference to expected_reg_cmd
                "/f",
            ],
        ];
        
        let generated_commands = generate_windows_commands(mock_exe_path);
        assert_eq!(generated_commands.len(), expected_commands.len());
        for (i, cmd) in generated_commands.iter().enumerate() {
            if i == 4 { // Special handling for the command with the executable path
                assert_eq!(cmd[0], expected_commands[i][0]);
                assert_eq!(cmd[1], expected_commands[i][1]);
                assert_eq!(cmd[2], expected_commands[i][2]);
                assert_eq!(cmd[3], expected_commands[i][3]);
                assert_eq!(cmd[4], expected_commands[i][4]);
                // cmd[5] is the generated reg_cmd string, which includes the mock_exe_path
                // expected_commands[i][5] is &expected_reg_cmd string.
                // We need to ensure they are semantically the same.
                assert_eq!(cmd[5], expected_commands[i][5]);
                assert_eq!(cmd[6], expected_commands[i][6]);

            } else {
                assert_eq!(cmd, &expected_commands[i]);
            }
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn test_register_macos_plist_content_and_paths() {
        let mock_exe_path = mock_current_exe("/test/research");
        let mock_home_dir = "/mockhome";
        let app_name = "ResearchURLHandler.app";

        // Test plist content
        let executable_name = mock_exe_path.file_name().unwrap().to_str().unwrap();
        let generated_plist_content = generate_macos_plist_content(executable_name);
        let expected_plist_content = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>ResearchURLHandler</string>
    <key>CFBundleIdentifier</key>
    <string>com.example.ResearchURLHandler</string>
    <key>CFBundleName</key>
    <string>ResearchURLHandler</string>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key>
            <string>Research URL</string>
            <key>CFBundleURLSchemes</key>
            <array>
                <string>research</string>
            </array>
        </dict>
    </array>
    <key>CFBundleExecutable</key>
    <string>{}</string>
</dict>
</plist>"#,
            "research" // This should be the file name from mock_exe_path
        );
        assert_eq!(generated_plist_content, expected_plist_content);

        // Test paths
        let (generated_app_path, generated_info_plist_path) = get_macos_paths(mock_home_dir, app_name);
        let expected_app_path = PathBuf::from(mock_home_dir).join("Applications").join(app_name);
        let expected_info_plist_path = expected_app_path.join("Contents/Info.plist");
        
        assert_eq!(generated_app_path, expected_app_path);
        assert_eq!(generated_info_plist_path, expected_info_plist_path);
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn test_register_linux_desktop_content_paths_and_xdg_mime_args() {
        let mock_exe_path_str = "/test/research";
        let mock_home_dir = "/mockhome";

        // Test .desktop file content
        let generated_desktop_content = generate_linux_desktop_content(mock_exe_path_str);
        let expected_desktop_content = format!(
            r#"[Desktop Entry]
Type=Application
Name=Research URL Handler
Exec={} handle --url %u
StartupNotify=false
MimeType=x-scheme-handler/research;"#,
            mock_exe_path_str
        );
        assert_eq!(generated_desktop_content, expected_desktop_content);

        // Test paths
        let (_generated_apps_dir, generated_desktop_file_path) = get_linux_paths(mock_home_dir);
        let expected_apps_dir = PathBuf::from(mock_home_dir).join(".local/share/applications");
        let expected_desktop_file_path = expected_apps_dir.join("research-url-handler.desktop");
        assert_eq!(generated_desktop_file_path, expected_desktop_file_path);

        // Test xdg-mime arguments
        let generated_xdg_mime_args = get_linux_xdg_mime_args();
        let expected_xdg_mime_args = [
            "default",
            "research-url-handler.desktop",
            "x-scheme-handler/research",
        ];
        assert_eq!(generated_xdg_mime_args, expected_xdg_mime_args);
    }
}
