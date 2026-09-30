pub mod adapters;
pub mod commands;
pub mod error;
pub mod project;
pub mod refsheet;
pub mod secrets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::project::create_project,
            commands::project::open_project,
            commands::project::save_project,
            commands::project::list_recent_projects,
            commands::project::duplicate_project,
            commands::settings::get_settings,
            commands::settings::save_settings,
            commands::llm::llm_complete,
            commands::llm::llm_stream,
            commands::asset::import_asset_image,
            commands::asset::delete_asset_files,
            commands::asset::delete_asset_dir,
            commands::asset::generate_asset_images,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
