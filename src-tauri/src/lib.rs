use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command as StdCommand, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use serde_json::Value;
use tauri::{LogicalSize, Manager, Monitor, PhysicalSize, Size, WebviewUrl};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{LPARAM, WPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    GetWindowLongPtrW, SendMessageW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, ICON_BIG,
    ICON_SMALL, SWP_FRAMECHANGED, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_SETICON,
    WS_EX_DLGMODALFRAME,
};

const EMBEDDED_SERVER_URL: &str = "http://127.0.0.1:3000";
const WINDOW_ASPECT_RATIO: f64 = 9.0 / 16.0;
const DEFAULT_WINDOW_HEIGHT_RATIO: f64 = 0.8;
const DEFAULT_WINDOW_HEIGHT: f64 = 800.0;
const MIN_WINDOW_HEIGHT: f64 = 680.0;
const MIN_WINDOW_WIDTH: f64 = MIN_WINDOW_HEIGHT * WINDOW_ASPECT_RATIO;

struct NodeServerProcess(Mutex<Option<Child>>);
struct WindowAspectState {
    pending_resize: Mutex<Option<PhysicalSize<u32>>>,
    last_applied_size: Mutex<Option<PhysicalSize<u32>>>,
}

fn width_for_height(height: u32) -> u32 {
    ((height as f64) * WINDOW_ASPECT_RATIO).round().max(1.0) as u32
}

fn height_for_width(width: u32) -> u32 {
    ((width as f64) / WINDOW_ASPECT_RATIO).round().max(1.0) as u32
}

fn logical_to_physical(value: f64, scale_factor: f64) -> u32 {
    (value * scale_factor).round().max(1.0) as u32
}

fn physical_to_logical_size(size: PhysicalSize<u32>, scale_factor: f64) -> LogicalSize<f64> {
    LogicalSize::new(
        size.width as f64 / scale_factor,
        size.height as f64 / scale_factor,
    )
}

fn min_aspect_physical_size(scale_factor: f64) -> PhysicalSize<u32> {
    let height = logical_to_physical(MIN_WINDOW_HEIGHT, scale_factor);
    PhysicalSize::new(width_for_height(height), height)
}

fn fit_initial_window_size(monitor: Option<&Monitor>) -> PhysicalSize<u32> {
    let fallback = PhysicalSize::new(
        width_for_height(DEFAULT_WINDOW_HEIGHT as u32),
        DEFAULT_WINDOW_HEIGHT as u32,
    );

    let Some(monitor) = monitor else {
        return fallback;
    };

    let work_area = monitor.work_area().size;
    let scale_factor = monitor.scale_factor();
    let min_size = min_aspect_physical_size(scale_factor);

    let mut height = ((work_area.height as f64) * DEFAULT_WINDOW_HEIGHT_RATIO).round() as u32;
    if height < min_size.height {
        height = min_size.height;
    }

    let mut size = PhysicalSize::new(width_for_height(height), height);

    if size.width > work_area.width {
        size.width = work_area.width;
        size.height = height_for_width(size.width);
    }

    if size.height > work_area.height {
        size.height = work_area.height;
        size.width = width_for_height(size.height);
    }

    size
}

fn clamp_aspect_size_to_monitor(
    mut size: PhysicalSize<u32>,
    previous: Option<PhysicalSize<u32>>,
    monitor: Option<&Monitor>,
    scale_factor: f64,
) -> PhysicalSize<u32> {
    let min_size = min_aspect_physical_size(scale_factor);
    let width_delta = previous.map(|prev| size.width.abs_diff(prev.width)).unwrap_or(0);
    let height_delta = previous.map(|prev| size.height.abs_diff(prev.height)).unwrap_or(0);
    let width_driven = previous.is_none() || width_delta >= height_delta;

    if width_driven {
        size.height = height_for_width(size.width);
    } else {
        size.width = width_for_height(size.height);
    }

    if size.height < min_size.height {
        size.height = min_size.height;
        size.width = width_for_height(size.height);
    }

    if size.width < min_size.width {
        size.width = min_size.width;
        size.height = height_for_width(size.width);
    }

    if let Some(monitor) = monitor {
        let work_area = monitor.work_area().size;

        if size.height > work_area.height {
            size.height = work_area.height;
            size.width = width_for_height(size.height);
        }

        if size.width > work_area.width {
            size.width = work_area.width;
            size.height = height_for_width(size.width);
        }
    }

    size
}

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

fn find_recent_antigravity_workspace() -> Option<PathBuf> {
    let app_data = std::env::var("APPDATA").ok()?;
    let storage_path = PathBuf::from(app_data)
        .join("Antigravity")
        .join("User")
        .join("globalStorage")
        .join("storage.json");

    let content = fs::read_to_string(storage_path).ok()?;
    let json: Value = serde_json::from_str(&content).ok()?;

    let folder_uri = json
        .get("windowsState")
        .and_then(|state| state.get("lastActiveWindow"))
        .and_then(|window| window.get("folder"))
        .and_then(Value::as_str)
        .or_else(|| {
            json.get("backupWorkspaces")
                .and_then(|backup| backup.get("folders"))
                .and_then(Value::as_array)
                .and_then(|folders| folders.first())
                .and_then(|folder| folder.get("folderUri"))
                .and_then(Value::as_str)
        })?;

    let url = url::Url::parse(folder_uri).ok()?;
    let path = url.to_file_path().ok()?;
    if path.exists() {
        Some(path)
    } else {
        None
    }
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
        let target_workspace = find_recent_antigravity_workspace()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        println!(
            "[TAURI] Launching Antigravity on workspace: {}",
            target_workspace.display()
        );

        match StdCommand::new(&exe_path)
            .arg(&target_workspace)
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

fn wait_for_local_server(timeout: Duration) -> bool {
    let addr = "127.0.0.1:3000".parse().unwrap();
    let start = Instant::now();

    while start.elapsed() < timeout {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(500)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(250));
    }

    false
}

fn resolve_project_root(app: &tauri::App) -> PathBuf {
    if cfg!(debug_assertions) {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
        PathBuf::from(manifest_dir)
            .parent()
            .unwrap_or(Path::new("."))
            .to_path_buf()
    } else {
        app.path().resource_dir().unwrap_or_default()
    }
}

fn resolve_runtime_dir(app: &tauri::App, project_root: &Path) -> PathBuf {
    if cfg!(debug_assertions) {
        project_root.to_path_buf()
    } else {
        app.path()
            .app_local_data_dir()
            .or_else(|_| app.path().app_data_dir())
            .unwrap_or_else(|_| project_root.to_path_buf())
    }
}

/// Start the Node.js server (only in release mode, dev uses beforeDevCommand)
fn start_node_server(app_dir: &Path, runtime_dir: &Path) -> Option<Child> {
    // Check if port 3000 is already in use (server already running or dev mode)
    if TcpStream::connect_timeout(
        &"127.0.0.1:3000".parse().unwrap(),
        Duration::from_millis(500),
    )
    .is_ok()
    {
        println!("[TAURI] Port 3000 already in use, server already running");
        return None;
    }

    println!("[TAURI] Starting Node.js server from: {}", app_dir.display());
    println!("[TAURI] Runtime data directory: {}", runtime_dir.display());

    match StdCommand::new("node")
        .arg("server.js")
        .current_dir(app_dir)
        .env("TAURI_EMBEDDED", "1")
        .env("AG_SKIP_AUTO_LAUNCH", "1")
        .env("AG_RUNTIME_DIR", runtime_dir)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
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

#[cfg(target_os = "windows")]
fn remove_windows_title_bar_icon(window: &tauri::WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        println!("[TAURI] Failed to read HWND, keeping default title bar icon");
        return;
    };

    unsafe {
        // Dialog frame style hides the caption icon while keeping the native title bar.
        let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let _ = SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style | WS_EX_DLGMODALFRAME.0 as isize);
        let _ = SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_SMALL as usize)),
            Some(LPARAM(0)),
        );
        let _ = SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_BIG as usize)),
            Some(LPARAM(0)),
        );
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_FRAMECHANGED,
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let project_root = resolve_project_root(app);
            let runtime_dir = resolve_runtime_dir(app, &project_root);
            fs::create_dir_all(&runtime_dir)?;

            println!("[TAURI] Project root: {}", project_root.display());
            println!("[TAURI] Runtime directory: {}", runtime_dir.display());

            // Launch Antigravity with CDP in background
            thread::spawn(|| {
                launch_antigravity_with_cdp();
            });

            // In release mode, start Node.js server ourselves
            // In dev mode, beforeDevCommand handles it
            let node_child = if !cfg!(debug_assertions) {
                start_node_server(&project_root, &runtime_dir)
            } else {
                // Dev mode: server started by beforeDevCommand
                println!("[TAURI] Dev mode: Node server managed by Tauri CLI");
                None
            };

            app.manage(NodeServerProcess(Mutex::new(node_child)));

            let wait_timeout = if cfg!(debug_assertions) {
                Duration::from_secs(30)
            } else {
                Duration::from_secs(20)
            };

            if wait_for_local_server(wait_timeout) {
                println!("[TAURI] Embedded server ready at {}", EMBEDDED_SERVER_URL);
            } else {
                println!(
                    "[TAURI] Embedded server did not respond within {:?}; opening window anyway",
                    wait_timeout
                );
            }

            let primary_monitor = app.primary_monitor()?;
            let initial_physical_size = fit_initial_window_size(primary_monitor.as_ref());
            let initial_scale_factor = primary_monitor
                .as_ref()
                .map(|monitor| monitor.scale_factor())
                .unwrap_or(1.0);
            let initial_logical_size =
                physical_to_logical_size(initial_physical_size, initial_scale_factor);
            let min_logical_size = LogicalSize::new(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT);

            app.manage(WindowAspectState {
                pending_resize: Mutex::new(None),
                last_applied_size: Mutex::new(Some(initial_physical_size)),
            });

            let main_window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(EMBEDDED_SERVER_URL.parse().expect("valid embedded server URL")),
            )
            .title("Antigravity Remote")
            .inner_size(initial_logical_size.width, initial_logical_size.height)
            .min_inner_size(min_logical_size.width, min_logical_size.height)
            .center()
            .resizable(true)
            .maximizable(false)
            .decorations(true)
            .transparent(false)
            .build()?;

            #[cfg(target_os = "windows")]
            remove_windows_title_bar_icon(&main_window);

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Resized(size) => {
                    if size.width == 0 || size.height == 0 {
                        return;
                    }

                    if let Some(state) = window.try_state::<WindowAspectState>() {
                        let is_pending_resize = state
                            .pending_resize
                            .lock()
                            .ok()
                            .map(|pending| pending.as_ref() == Some(size))
                            .unwrap_or(false);

                        if is_pending_resize {
                            if let Ok(mut pending_resize) = state.pending_resize.lock() {
                                *pending_resize = None;
                            }
                            if let Ok(mut last_applied_size) = state.last_applied_size.lock() {
                                *last_applied_size = Some(*size);
                            }
                            return;
                        }

                        let previous_size = state
                            .last_applied_size
                            .lock()
                            .ok()
                            .and_then(|guard| *guard);
                        let monitor = window
                            .current_monitor()
                            .ok()
                            .flatten()
                            .or_else(|| window.primary_monitor().ok().flatten());
                        let scale_factor = monitor
                            .as_ref()
                            .map(|current| current.scale_factor())
                            .or_else(|| window.scale_factor().ok())
                            .unwrap_or(1.0);
                        let corrected_size = clamp_aspect_size_to_monitor(
                            *size,
                            previous_size,
                            monitor.as_ref(),
                            scale_factor,
                        );

                        if let Ok(mut last_applied_size) = state.last_applied_size.lock() {
                            *last_applied_size = Some(corrected_size);
                        }

                        if corrected_size != *size {
                            if let Ok(mut pending_resize) = state.pending_resize.lock() {
                                *pending_resize = Some(corrected_size);
                            }
                            let _ = window.set_size(Size::Physical(corrected_size));
                        }
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if let Some(state) = window.try_state::<NodeServerProcess>() {
                        if let Ok(mut child) = state.0.lock() {
                            if let Some(ref mut process) = *child {
                                println!("[TAURI] Killing Node.js server (PID: {})", process.id());
                                let _ = process.kill();
                            }
                        }
                    }
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Antigravity Remote");
}
