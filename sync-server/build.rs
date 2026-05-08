fn main() {
    // trigger recompilation when a new migration is added
    println!("cargo:rerun-if-changed=migrations");

    // Ensure the history-ui dist directory exists so rust-embed can compile
    // even when the frontend hasn't been built yet.
    let dist_path = std::path::Path::new("../frontend/history-ui/dist");
    if !dist_path.exists() {
        std::fs::create_dir_all(dist_path).expect("Failed to create history-ui dist directory");
        std::fs::write(
            dist_path.join("index.html"),
            "<!DOCTYPE html><html><body><p>Run <code>npm run build -w history-ui</code> first.</p></body></html>",
        )
        .expect("Failed to write placeholder index.html");
    }
}
