export type DistillationTargetKind =
  | "wiki_file"
  | "vibe_memory"
  | "knowledge_candidate"
  | "web_ingest";

export type DistillationTargetStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "failed"
  | "paused";

export type DistillationTargetPriorityGroup =
  | "knowledge_candidate"
  | "web_ingest"
  | "wiki"
  | "vibe_memory";
