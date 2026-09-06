//! episode executor entry points; implementation is separated by responsibility.
mod deduplication;
mod distillation;
mod entry;
mod helpers;
mod identity;
mod lease;
mod persistence;
mod processing;
mod progress;
mod quality;
mod source;
mod store;
mod tests;
mod types;
pub(crate) use entry::{
    run_episode_distiller_job_for_connection, run_episode_distiller_job_for_path,
};
pub(crate) use types::{EpisodeExecutionStatus, EpisodeSplitStatus, LocalLlmTargetConfig};
