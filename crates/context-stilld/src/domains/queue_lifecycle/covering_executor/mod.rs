//! covering executor entry points; implementation is separated by responsibility.
mod applicability;
mod deduplication;
mod execution;
mod external_evidence;
mod external_fetch;
mod heartbeat;
mod helpers;
mod negative_response;
mod persistence;
mod positive_response;
mod provider;
mod source;
mod tests;
mod types;
pub(crate) use execution::{execute_covering, load_claimed_negative_execution};
pub(crate) use heartbeat::NegativeCoveringHeartbeatGuard;
pub(crate) use persistence::persist_negative_covering_result;
pub(crate) use types::{
    CoveringExternalSearchConfig, NegativeCoveringExecution, NegativeCoveringPersistStatus,
    NegativeCoveringResult,
};
