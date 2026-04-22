use std::{fs, path::PathBuf};

use anyhow::{Context, Result};
use clap::Subcommand;
use posthog_symbol_data::{read_symbol_data, AppleDsym, HermesMap, ProguardMapping, SourceAndMap};
use tracing::info;

use crate::{api::symbol_sets, invocation_context::context};

const MAGIC: &[u8] = b"posthog_error_tracking";

#[derive(Subcommand)]
pub enum SymbolSetsSubcommand {
    /// Download and extract a symbol set (sourcemap, hermes, proguard, or dSYM)
    Download(Args),
}

#[derive(clap::Args, Clone)]
pub struct Args {
    /// Symbol set ID to download. If omitted, lists available symbol sets.
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

    fs::create_dir_all(&args.output).context("Failed to create output directory")?;

    let base_name = derive_base_name(&symbol_set.r#ref);
    let data_type = read_data_type(&data)?;

    match data_type {
        2 => {
            // SourceAndMap
            let parsed = read_symbol_data::<SourceAndMap>(data)
                .context("Failed to parse as SourceAndMap")?;

            let source_path = args.output.join(format!("{base_name}.js"));
            fs::write(&source_path, &parsed.minified_source)
                .context("Failed to write source file")?;
            info!("Wrote {}", source_path.display());

            let map_path = args.output.join(format!("{base_name}.js.map"));
            fs::write(&map_path, &parsed.sourcemap)
                .context("Failed to write sourcemap file")?;
            info!("Wrote {}", map_path.display());

            println!(
                "Extracted source and sourcemap to {}",
                args.output.display()
            );
        }
        3 => {
            // HermesMap
            let parsed =
                read_symbol_data::<HermesMap>(data).context("Failed to parse as HermesMap")?;

            let map_path = args.output.join(format!("{base_name}.hbc.map"));
            fs::write(&map_path, &parsed.sourcemap)
                .context("Failed to write hermes sourcemap")?;
            info!("Wrote {}", map_path.display());

            println!("Extracted hermes sourcemap to {}", args.output.display());
        }
        4 => {
            // ProguardMapping
            let parsed = read_symbol_data::<ProguardMapping>(data)
                .context("Failed to parse as ProguardMapping")?;

            let map_path = args.output.join(format!("{base_name}.txt"));
            fs::write(&map_path, &parsed.content)
                .context("Failed to write proguard mapping")?;
            info!("Wrote {}", map_path.display());

            println!("Extracted proguard mapping to {}", args.output.display());
        }
        5 => {
            // AppleDsym
            let parsed =
                read_symbol_data::<AppleDsym>(data).context("Failed to parse as AppleDsym")?;

            let dsym_path = args.output.join(format!("{base_name}.dSYM"));
            fs::write(&dsym_path, &parsed.data).context("Failed to write dSYM file")?;
            info!("Wrote {}", dsym_path.display());

            println!("Extracted dSYM to {}", args.output.display());
        }
        other => {
            anyhow::bail!("Unknown symbol data type: {other}");
        }
    }

    Ok(())
}

/// Read the data type field from the symbol data header.
fn read_data_type(data: &[u8]) -> Result<u32> {
    let min_len = MAGIC.len() + 4 + 4; // magic + version + type
    anyhow::ensure!(
        data.len() >= min_len,
        "Data too short to contain a valid symbol data header"
    );
    anyhow::ensure!(
        &data[..MAGIC.len()] == MAGIC,
        "Invalid magic bytes — not a PostHog symbol data file"
    );
    let type_offset = MAGIC.len() + 4;
    Ok(u32::from_le_bytes(
        data[type_offset..type_offset + 4].try_into().unwrap(),
    ))
}

/// Extract a reasonable base filename from the symbol set ref.
fn derive_base_name(ref_str: &str) -> String {
    let name = ref_str.rsplit('/').next().unwrap_or(ref_str);
    // Strip common extensions so we can re-add the correct ones
    let name = name
        .strip_suffix(".js.map")
        .or_else(|| name.strip_suffix(".hbc.map"))
        .or_else(|| name.strip_suffix(".map"))
        .or_else(|| name.strip_suffix(".js"))
        .or_else(|| name.strip_suffix(".txt"))
        .or_else(|| name.strip_suffix(".dSYM"))
        .unwrap_or(name);

    if name.is_empty() {
        "symbol_set".to_string()
    } else {
        name.to_string()
    }
}
