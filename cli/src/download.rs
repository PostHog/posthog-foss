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
    Download(DownloadArgs),
    /// Extract a local symbol set binary file (decompress and split)
    Extract(ExtractArgs),
}

#[derive(clap::Args, Clone)]
pub struct DownloadArgs {
    /// Symbol set ID to download
    pub id: String,

    /// Output directory for extracted files
    #[arg(short, long, default_value = ".")]
    pub output: PathBuf,
}

#[derive(clap::Args, Clone)]
pub struct ExtractArgs {
    /// Path to the symbol set binary file
    pub file: PathBuf,

    /// Output directory for extracted files
    #[arg(short, long, default_value = ".")]
    pub output: PathBuf,
}

pub fn download(args: &DownloadArgs) -> Result<()> {
    context().capture_command_invoked("symbolset_download");

    info!("Downloading symbol set {}", args.id);
    let data = symbol_sets::download_bytes(&args.id)?;
    info!("Downloaded {} bytes", data.len());

    extract_symbol_data(&data, &args.id, &args.output)
}

pub fn extract(args: &ExtractArgs) -> Result<()> {
    let data = fs::read(&args.file)
        .context(format!("Failed to read file {}", args.file.display()))?;
    info!("Read {} bytes from {}", data.len(), args.file.display());

    let base_name = derive_base_name(
        args.file
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("symbol_set"),
    );
    extract_symbol_data(&data, &base_name, &args.output)
}

fn extract_symbol_data(data: &[u8], base_name: &str, output: &PathBuf) -> Result<()> {
    fs::create_dir_all(output).context("Failed to create output directory")?;

    let data_type = read_data_type(data)?;

    match data_type {
        2 => {
            // SourceAndMap
            let parsed = read_symbol_data::<SourceAndMap>(data.to_vec())
                .context("Failed to parse as SourceAndMap")?;

            let source_path = output.join(format!("{base_name}.js"));
            fs::write(&source_path, &parsed.minified_source)
                .context("Failed to write source file")?;
            info!("Wrote {}", source_path.display());

            let map_path = output.join(format!("{base_name}.js.map"));
            fs::write(&map_path, &parsed.sourcemap)
                .context("Failed to write sourcemap file")?;
            info!("Wrote {}", map_path.display());

            println!("Extracted source and sourcemap to {}", output.display());
        }
        3 => {
            // HermesMap
            let parsed = read_symbol_data::<HermesMap>(data.to_vec())
                .context("Failed to parse as HermesMap")?;

            let map_path = output.join(format!("{base_name}.hbc.map"));
            fs::write(&map_path, &parsed.sourcemap)
                .context("Failed to write hermes sourcemap")?;
            info!("Wrote {}", map_path.display());

            println!("Extracted hermes sourcemap to {}", output.display());
        }
        4 => {
            // ProguardMapping
            let parsed = read_symbol_data::<ProguardMapping>(data.to_vec())
                .context("Failed to parse as ProguardMapping")?;

            let map_path = output.join(format!("{base_name}.txt"));
            fs::write(&map_path, &parsed.content)
                .context("Failed to write proguard mapping")?;
            info!("Wrote {}", map_path.display());

            println!("Extracted proguard mapping to {}", output.display());
        }
        5 => {
            // AppleDsym
            let parsed = read_symbol_data::<AppleDsym>(data.to_vec())
                .context("Failed to parse as AppleDsym")?;

            let dsym_path = output.join(format!("{base_name}.dSYM"));
            fs::write(&dsym_path, &parsed.data).context("Failed to write dSYM file")?;
            info!("Wrote {}", dsym_path.display());

            println!("Extracted dSYM to {}", output.display());
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
