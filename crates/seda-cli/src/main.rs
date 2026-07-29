use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use seda_core::{
    Catalog, InstallEvent, Installer, ModelPurpose, ModelSpec, Paths, RecognitionEngine,
};
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
    /// Download and verify one concrete model and runtime.
    Prepare {
        #[command(flatten)]
        model: ModelArgs,
        /// Emit stable progress events as JSON Lines on stdout.
        #[arg(long)]
        jsonl: bool,
    },
    /// List exact model IDs, revisions, variants, and profile aliases.
    Models {
        #[arg(long)]
        json: bool,
    },
    /// Inspect this machine and report installation readiness.
    Doctor(ModelArgs),
    /// Transcribe a mono PCM WAV file.
    Transcribe {
        input: PathBuf,
        #[command(flatten)]
        model: ModelArgs,
        /// Language for this transcription only. Omit for model auto/default.
        #[arg(long)]
        language: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// Run the authenticated local HTTP and WebSocket service.
    Serve(ServeArgs),
}

#[derive(Debug, Clone, Args)]
struct ModelArgs {
    /// Exact upstream model ID, for example nvidia/nemotron-3.5-asr-streaming-0.6b.
    #[arg(long, conflicts_with = "profile")]
    model_id: Option<String>,
    /// Quantized/runtime variant such as `q4_k` or `q8_0`.
    #[arg(long, requires = "model_id")]
    variant: Option<String>,
    /// Optional hardware-aware alias. Exact model IDs are preferred.
    #[arg(long, conflicts_with = "model_id")]
    profile: Option<Profile>,
}

#[derive(Debug, Clone, Args)]
struct ServeArgs {
    #[command(flatten)]
    model: ModelArgs,
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
        Command::Prepare { model: args, jsonl } => {
            let model = args.resolve(&catalog)?.clone();
            let installer = Installer::new(paths, catalog)?;
            let reporter = move |event| {
                if jsonl {
                    print_install_event_json(&event);
                } else {
                    print_install_event(event);
                }
            };
            let prepared = installer
                .prepare(&model.id, Some(&model.variant), reporter)
                .await?;
            if jsonl {
                println!(
                    "{}",
                    serde_json::json!({
                        "type": "prepared",
                        "resolvedModel": prepared.model.identity(),
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
                        "{:<51} {:<8} {:<10} {:>7} MB  {}",
                        model.id,
                        model.variant,
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
            model,
            language,
            json,
        } => {
            let engine = load_parakeet(&catalog, &paths, &model)?;
            let language = engine.metadata().resolve_language(language.as_deref())?;
            let (pcm, sample_rate) = read_wav(&input)?;
            let transcript = engine.transcribe(&pcm, sample_rate, &language)?;
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
        EngineChoice::Parakeet => Arc::new(load_parakeet(&catalog, &paths, &args.model)?),
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

fn load_parakeet(catalog: &Catalog, paths: &Paths, args: &ModelArgs) -> Result<ParakeetEngine> {
    let model = args.resolve(catalog)?;
    let prepared = catalog
        .prepared(paths, &model.id, Some(&model.variant))
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
    requested_model_id: Option<String>,
    requested_variant: Option<String>,
    requested_profile: Option<Profile>,
    ready: bool,
    resolved_model: Option<seda_protocol::ModelIdentity>,
    model_path: Option<PathBuf>,
    runtime_path: Option<PathBuf>,
    error: Option<String>,
}

impl DoctorReport {
    fn collect(catalog: &Catalog, paths: &Paths, args: &ModelArgs) -> Self {
        let resolved = args.resolve(catalog);
        let prepared = resolved.and_then(|model| {
            catalog
                .prepared(paths, &model.id, Some(&model.variant))
                .map_err(Into::into)
        });
        match prepared {
            Ok(prepared) => Self {
                platform: platform(),
                requested_model_id: args.model_id.clone(),
                requested_variant: args.variant.clone(),
                requested_profile: args.profile,
                ready: true,
                resolved_model: Some(prepared.model.identity()),
                model_path: Some(prepared.model_path),
                runtime_path: Some(prepared.library_path),
                error: None,
            },
            Err(error) => Self {
                platform: platform(),
                requested_model_id: args.model_id.clone(),
                requested_variant: args.variant.clone(),
                requested_profile: args.profile,
                ready: false,
                resolved_model: None,
                model_path: None,
                runtime_path: None,
                error: Some(error.to_string()),
            },
        }
    }
}

impl ModelArgs {
    fn resolve<'a>(&self, catalog: &'a Catalog) -> Result<&'a ModelSpec> {
        if let Some(model_id) = &self.model_id {
            return catalog
                .resolve_model_id(model_id, self.variant.as_deref(), ModelPurpose::Realtime)
                .map_err(Into::into);
        }
        catalog
            .resolve_profile(self.profile.unwrap_or_default(), ModelPurpose::Realtime)
            .map_err(Into::into)
    }
}

fn platform() -> String {
    format!("{}/{}", std::env::consts::OS, std::env::consts::ARCH)
}
