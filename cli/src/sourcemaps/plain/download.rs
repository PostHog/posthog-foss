use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use posthog_symbol_data::{read_symbol_data, SourceAndMap};
use tracing::info;

use crate::{api::symbol_sets, invocation_context::context};

#[derive(clap::Args, Clone)]
pub struct Args {
    /// Symbol set ID to download. If omitted, lists available symbol sets interactively.
    #[arg(long)]
    pub id: Option<String>,

    /// Output directory for extracted files
    #[arg(short, long, default_value = ".")]
    pub output: PathBuf,
}

pub fn download(args: &Args) -> Result<()> {
    context().capture_command_invoked("sourcemap_download");

    let symbol_set = match &args.id {
        Some(id) => {
            info!("Downloading symbol set {id}");
            let items = symbol_sets::list_all()?;
            items
                .into_iter()
                .find(|s| s.id == *id)
                .context(format!("Symbol set with ID {id} not found"))?
        }
        None => {
            let items = symbol_sets::list_all()?;
            if items.is_empty() {
                anyhow::bail!("No uploaded symbol sets found for this project");
            }

            println!("Available symbol sets:");
            for (i, item) in items.iter().enumerate() {
                println!("  [{}] {} ({})", i + 1, item.r#ref, item.id);
            }

            anyhow::bail!("Please specify a symbol set ID with --id");
        }
    };

    info!("Downloading symbol set: {}", symbol_set.r#ref);
    let data = symbol_sets::download_bytes(&symbol_set.id)?;
    info!("Downloaded {} bytes", data.len());

    fs::create_dir_all(&args.output)
        .context("Failed to create output directory")?;

    let base_name = derive_base_name(&symbol_set.r#ref);

    // Try to parse as SourceAndMap (JS sourcemaps) and decompress
    match read_symbol_data::<SourceAndMap>(data) {
        Ok(source_and_map) => {
            let source_path = args.output.join(format!("{base_name}.js"));
            fs::write(&source_path, &source_and_map.minified_source)
                .context("Failed to write source file")?;
            info!("Wrote {}", source_path.display());

            let map_path = args.output.join(format!("{base_name}.js.map"));
            fs::write(&map_path, &source_and_map.sourcemap)
                .context("Failed to write sourcemap file")?;
            info!("Wrote {}", map_path.display());

            println!("Extracted source and sourcemap to {}", args.output.display());
        }
        Err(e) => {
            anyhow::bail!("Failed to parse symbol set: {e}. Only JS source+map bundles are supported.");
        }
    }

    Ok(())
}

/// Extract a reasonable base filename from the symbol set ref.
fn derive_base_name(ref_str: &str) -> String {
    let name = ref_str.rsplit('/').next().unwrap_or(ref_str);
    // Strip common extensions so we can re-add the correct ones
    let name = name
        .strip_suffix(".js.map")
        .or_else(|| name.strip_suffix(".map"))
        .or_else(|| name.strip_suffix(".js"))
        .unwrap_or(name);

    if name.is_empty() {
        "symbol_set".to_string()
    } else {
        name.to_string()
    }
}
