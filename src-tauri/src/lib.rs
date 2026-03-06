use std::process::Command as StdCommand;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::Manager;

struct NodeServerProcess(Mutex<Option<std::process::Child>>);

/// Check if CDP is available on any of the standard ports
fn is_cdp_available() -> bool {
    for port in [9000u16, 9001, 9002, 9003] {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{}", port).parse().unwrap(),
            Duration::from_millis(500),
        )
        .is_ok()
        {
            println!("[TAURI] CDP found on port {}", port);
            return true;
        }
    }
    false
}

/// Find Antigravity.exe path
fn find_antigravity_exe() -> Option<String> {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let path = format!("{}\\Programs\\Antigravity\\Antigravity.exe", local_app_data);
        if std::path::Path::new(&path).exists() {
            return Some(path);
        }
    }

    if let Ok(output) = StdCommand::new("where")
        .arg("Antigravity.exe")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(path.lines().next().unwrap_or("").to_string());
            }
        }
    }

    None
}

/// Launch Antigravity with CDP debug port
fn launch_antigravity_with_cdp() {
    if is_cdp_available() {
        println!("[TAURI] Antigravity CDP already available, skipping launch");
        return;
    }

    println!("[TAURI] CDP not found, attempting to launch Antigravity...");

    if let Some(exe_path) = find_antigravity_exe() {
        println!("[TAURI] Found Antigravity at: {}", exe_path);

        match StdCommand::new(&exe_path)
            .arg(".")
            .arg("--remote-debugging-port=9000")
            .spawn()
        {
            Ok(_) => {
                println!("[TAURI] Antigravity launched with --remote-debugging-port=9000");
                for i in 0..15 {
                    thread::sleep(Duration::from_secs(2));
                    if is_cdp_available() {
                        println!("[TAURI] CDP ready after {}s", (i + 1) * 2);
                        return;
                    }
                }
                println!("[TAURI] Warning: CDP not available after 30s, server will retry");
            }
            Err(e) => {
                println!("[TAURI] Failed to launch Antigravity: {}", e);
            }
        }
    } else {
        println!("[TAURI] Antigravity.exe not found. Please install or launch manually.");
    }
}

/// Start the Node.js server (only in release mode, dev uses beforeDevCommand)
fn start_node_server(app_dir: &str) -> Option<std::process::Child> {
    // Check if port 3000 is already in use (server already running or dev mode)
    if std::net::TcpStream::connect_timeout(
        &"127.0.0.1:3000".parse().unwrap(),
        Duration::from_millis(500),
    )
    .is_ok()
    {
        println!("[TAURI] Port 3000 already in use, server already running");
        return None;
    }

    println!("[TAURI] Starting Node.js server from: {}", app_dir);

    match StdCommand::new("node")
        .arg("server.js")
        .current_dir(app_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => {
            println!("[TAURI] Node.js server started (PID: {})", child.id());
            Some(child)
        }
        Err(e) => {
            println!("[TAURI] Failed to start Node.js server: {}", e);
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Get the project root directory
            let project_root = if cfg!(debug_assertions) {
                let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
                    .unwrap_or_else(|_| ".".to_string());
                std::path::PathBuf::from(manifest_dir)
                    .parent()
                    .unwrap_or(std::path::Path::new("."))
                    .to_path_buf()
            } else {
                app.path().resource_dir().unwrap_or_default()
            };

            let project_root_str = project_root.to_string_lossy().to_string();
            println!("[TAURI] Project root: {}", project_root_str);

            // Launch Antigravity with CDP in background
            thread::spawn(|| {
                launch_antigravity_with_cdp();
            });

            // In release mode, start Node.js server ourselves
            // In dev mode, beforeDevCommand handles it
            let node_child = if !cfg!(debug_assertions) {
                start_node_server(&project_root_str)
            } else {
                // Dev mode: server started by beforeDevCommand
                println!("[TAURI] Dev mode: Node server managed by Tauri CLI");
                None
            };

            app.manage(NodeServerProcess(Mutex::new(node_child)));

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<NodeServerProcess>() {
                    if let Ok(mut child) = state.0.lock() {
                        if let Some(ref mut process) = *child {
                            println!("[TAURI] Killing Node.js server (PID: {})", process.id());
                            let _ = process.kill();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Antigravity Remote");
}
