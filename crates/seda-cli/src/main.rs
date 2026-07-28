use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use seda_core::{Catalog, InstallEvent, Installer, Paths, RecognitionEngine};
use seda_parakeet::ParakeetEngine;
use seda_protocol::Profile;
use seda_server::{ServerState, app};
use serde::Serialize;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(name = "seda", version, about = "Local speech, one clean pipe")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Download and verify the runtime and model for a profile.
    Prepare {
        #[command(flatten)]
        profile: ProfileArgs,
        /// Emit stable progress events as JSON Lines on stdout.
        #[arg(long)]
        jsonl: bool,
    },
    /// List available model profiles and exact model artifacts.
    Models {
        #[arg(long)]
        json: bool,
    },
    /// Inspect this machine and report installation readiness.
    Doctor(ProfileArgs),
    /// Transcribe a mono PCM WAV file.
    Transcribe {
        input: PathBuf,
        #[command(flatten)]
        profile: ProfileArgs,
        #[arg(long)]
        json: bool,
    },
    /// Run the authenticated local HTTP and WebSocket service.
    Serve(ServeArgs),
}

#[derive(Debug, Clone, Args)]
struct ProfileArgs {
    #[arg(long, default_value = "balanced")]
    profile: Profile,
    #[arg(long, default_value = "auto")]
    language: String,
}

#[derive(Debug, Clone, Args)]
struct ServeArgs {
    #[command(flatten)]
    profile: ProfileArgs,
    #[arg(long, default_value = "127.0.0.1:0")]
    listen: SocketAddr,
    #[arg(long, env = "SEDA_TOKEN")]
    token: Option<String>,
    #[arg(long)]
    allow_network: bool,
    #[arg(long = "allow-origin")]
    allowed_origins: Vec<String>,
    #[arg(long, value_enum, default_value = "parakeet")]
    engine: EngineChoice,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum EngineChoice {
    Parakeet,
    #[cfg(feature = "test-engine")]
    Fixture,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("seda=info,tower_http=info")),
        )
        .with_writer(std::io::stderr)
        .init();

    let cli = Cli::parse();
    let paths = Paths::discover()?;
    let catalog = Catalog::embedded()?;
    match cli.command {
        Command::Prepare {
            profile: args,
            jsonl,
        } => {
            let installer = Installer::new(paths, catalog)?;
            let reporter = move |event| {
                if jsonl {
                    print_install_event_json(&event);
                } else {
                    print_install_event(event);
                }
            };
            let prepared = installer
                .prepare(args.profile, &args.language, reporter)
                .await?;
            if jsonl {
                println!(
                    "{}",
                    serde_json::json!({
                        "type": "prepared",
                        "profile": args.profile,
                        "language": args.language,
                        "model": prepared.model.id,
                        "path": prepared.model_path,
                    })
                );
            } else {
                println!(
                    "Ready: {} ({})",
                    prepared.model.display_name,
                    prepared.model_path.display()
                );
            }
        }
        Command::Models { json } => {
            if json {
                println!("{}", serde_json::to_string_pretty(&catalog.models)?);
            } else {
                for model in catalog.models {
                    println!(
                        "{:<42} {:<10} {:>7} MB  {}",
                        model.id,
                        model
                            .profiles
                            .iter()
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                            .join(","),
                        decimal_megabytes(model.size),
                        model.display_name
                    );
                }
            }
        }
        Command::Doctor(args) => {
            let report = DoctorReport::collect(&catalog, &paths, &args);
            println!("{}", serde_json::to_string_pretty(&report)?);
        }
        Command::Transcribe {
            input,
            profile,
            json,
        } => {
            let engine = load_parakeet(&catalog, &paths, &profile)?;
            let (pcm, sample_rate) = read_wav(&input)?;
            let transcript = engine.transcribe(&pcm, sample_rate, &profile.language)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&transcript)?);
            } else {
                println!("{}", transcript.text);
            }
        }
        Command::Serve(args) => serve(catalog, paths, args).await?,
    }
    Ok(())
}

async fn serve(catalog: Catalog, paths: Paths, args: ServeArgs) -> Result<()> {
    if !args.listen.ip().is_loopback() && !args.allow_network {
        bail!("refusing a non-loopback address without --allow-network");
    }
    let token = args.token.unwrap_or_else(random_token);
    let engine: Arc<dyn RecognitionEngine> = match args.engine {
        EngineChoice::Parakeet => Arc::new(load_parakeet(&catalog, &paths, &args.profile)?),
        #[cfg(feature = "test-engine")]
        EngineChoice::Fixture => Arc::new(seda_server::test_engine::FixtureEngine::default()),
    };
    let state = ServerState::new(engine, token.clone(), args.allowed_origins)?;
    let listener = tokio::net::TcpListener::bind(args.listen)
        .await
        .with_context(|| format!("could not bind {}", args.listen))?;
    let address = listener.local_addr()?;
    println!(
        "{}",
        serde_json::json!({
            "type": "ready",
            "protocol": 1,
            "address": address,
            "token": token,
        })
    );
    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn load_parakeet(catalog: &Catalog, paths: &Paths, args: &ProfileArgs) -> Result<ParakeetEngine> {
    let prepared = catalog
        .prepared(paths, args.profile, &args.language)
        .context("model is not ready; run `seda prepare` first")?;
    ParakeetEngine::load(
        &prepared.library_path,
        &prepared.model_path,
        &prepared.model,
    )
    .map_err(Into::into)
}

fn print_install_event(event: InstallEvent) {
    match event {
        InstallEvent::Resolving => eprintln!("Resolving model..."),
        InstallEvent::Downloading(progress) => {
            eprint!(
                "\rDownloading {}: {:>5}% ({}/{} MB)",
                progress.id,
                percentage(progress.completed_bytes, progress.total_bytes),
                decimal_megabytes(progress.completed_bytes),
                decimal_megabytes(progress.total_bytes)
            );
        }
        InstallEvent::Verifying { id } => eprintln!("\nVerifying {id}..."),
        InstallEvent::Installing { id } => eprintln!("Installing {id}..."),
        InstallEvent::Ready { id } => eprintln!("Ready: {id}"),
    }
}

fn decimal_megabytes(bytes: u64) -> String {
    let tenths = u128::from(bytes) * 10 / 1_000_000;
    format!("{}.{:01}", tenths / 10, tenths % 10)
}

fn percentage(completed: u64, total: u64) -> String {
    if total == 0 {
        return "0.0".to_owned();
    }
    let tenths = u128::from(completed) * 1000 / u128::from(total);
    format!("{}.{:01}", tenths / 10, tenths % 10)
}

fn print_install_event_json(event: &InstallEvent) {
    let value = match event {
        InstallEvent::Resolving => serde_json::json!({ "type": "resolving" }),
        InstallEvent::Downloading(progress) => serde_json::json!({
            "type": "downloading",
            "id": progress.id,
            "completedBytes": progress.completed_bytes,
            "totalBytes": progress.total_bytes,
        }),
        InstallEvent::Verifying { id } => {
            serde_json::json!({ "type": "verifying", "id": id })
        }
        InstallEvent::Installing { id } => {
            serde_json::json!({ "type": "installing", "id": id })
        }
        InstallEvent::Ready { id } => serde_json::json!({ "type": "ready", "id": id }),
    };
    println!("{value}");
}

fn read_wav(path: &PathBuf) -> Result<(Vec<f32>, u32)> {
    let mut reader = hound::WavReader::open(path)
        .with_context(|| format!("could not open {}", path.display()))?;
    let spec = reader.spec();
    if spec.channels != 1 {
        bail!("WAV input must have exactly one channel");
    }
    let pcm = match spec.sample_format {
        hound::SampleFormat::Int if spec.bits_per_sample == 16 => reader
            .samples::<i16>()
            .map(|sample| sample.map(|value| f32::from(value) / 32_768.0))
            .collect::<std::result::Result<Vec<_>, _>>()?,
        hound::SampleFormat::Float if spec.bits_per_sample == 32 => {
            reader
                .samples::<f32>()
                .collect::<std::result::Result<Vec<_>, _>>()?
        }
        _ => bail!("WAV input must use 16-bit integer or 32-bit float PCM"),
    };
    Ok((pcm, spec.sample_rate))
}

fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DoctorReport {
    platform: String,
    profile: Profile,
    language: String,
    ready: bool,
    model: Option<String>,
    model_path: Option<PathBuf>,
    runtime_path: Option<PathBuf>,
    error: Option<String>,
}

impl DoctorReport {
    fn collect(catalog: &Catalog, paths: &Paths, args: &ProfileArgs) -> Self {
        match catalog.prepared(paths, args.profile, &args.language) {
            Ok(prepared) => Self {
                platform: platform(),
                profile: args.profile,
                language: args.language.clone(),
                ready: true,
                model: Some(prepared.model.id),
                model_path: Some(prepared.model_path),
                runtime_path: Some(prepared.library_path),
                error: None,
            },
            Err(error) => Self {
                platform: platform(),
                profile: args.profile,
                language: args.language.clone(),
                ready: false,
                model: None,
                model_path: None,
                runtime_path: None,
                error: Some(error.to_string()),
            },
        }
    }
}

fn platform() -> String {
    format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH)
}
