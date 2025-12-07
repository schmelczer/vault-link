use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=../docs");

    let docs_dir = PathBuf::from("../docs");
    let dist_dir = docs_dir.join(".vitepress").join("dist");

    // Check if npm is available
    let npm_check = if cfg!(target_os = "windows") {
        Command::new("cmd")
            .args(["/C", "npm", "--version"])
            .output()
    } else {
        Command::new("npm").arg("--version").output()
    };

    match npm_check {
        Ok(output) if output.status.success() => {
            println!("cargo:warning=Building VitePress documentation...");

            // Install dependencies if node_modules doesn't exist
            if !docs_dir.join("node_modules").exists() {
                println!("cargo:warning=Installing npm dependencies...");
                let npm_install = if cfg!(target_os = "windows") {
                    Command::new("cmd")
                        .args(["/C", "npm", "install"])
                        .current_dir(&docs_dir)
                        .status()
                } else {
                    Command::new("npm")
                        .arg("install")
                        .current_dir(&docs_dir)
                        .status()
                };

                if let Err(e) = npm_install {
                    println!("cargo:warning=Failed to install npm dependencies: {e}");
                    println!("cargo:warning=Docs will not be embedded in the binary");
                    return;
                }
            }

            // Build the VitePress docs
            let build_result = if cfg!(target_os = "windows") {
                Command::new("cmd")
                    .args(["/C", "npm", "run", "build"])
                    .current_dir(&docs_dir)
                    .status()
            } else {
                Command::new("npm")
                    .args(["run", "build"])
                    .current_dir(&docs_dir)
                    .status()
            };

            match build_result {
                Ok(status) if status.success() => {
                    println!("cargo:warning=VitePress docs built successfully at {dist_dir:?}");
                }
                Ok(status) => {
                    println!("cargo:warning=VitePress build failed with status: {status}");
                    println!("cargo:warning=Docs will not be embedded in the binary");
                }
                Err(e) => {
                    println!("cargo:warning=Failed to build VitePress docs: {e}");
                    println!("cargo:warning=Docs will not be embedded in the binary");
                }
            }
        }
        _ => {
            println!("cargo:warning=npm not found - skipping VitePress build");
            println!("cargo:warning=Docs will not be embedded in the binary");
        }
    }
}
