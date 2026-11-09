// Shared data and message contracts for the extension host and webview.
export interface Change {
  id: string;
  repo: string;
  path: string;
  originalPath?: string;
  group: "working" | "staged" | "conflict";
  status: string;
}

export interface Repository {
  id: string;
  root: string;
  name: string;
  branch: string;
  changes: Change[];
  indexToken: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  syncError?: string;
  error?: string;
}

export interface Snapshot {
  repositories: Repository[];
}

export interface Hunk {
  id: string;
  header: string;
  originalLine: number;
  originalLines: number;
  modifiedLine: number;
  modifiedLines: number;
}

export interface FileView {
  change: Change;
  before: string;
  after: string;
  yours?: string;
  theirs?: string;
  base?: string;
  reason?: string;
  hunks: Hunk[];
  editable: boolean;
  token: string;
}

export interface Branch {
  ref: string;
  name: string;
  kind: "local" | "remote";
  current: boolean;
  upstream?: string;
  worktree?: string;
  localName?: string;
}

export interface BranchList {
  branches: Branch[];
  token: string;
}

export interface CommitSummary {
  oid: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
}

export interface HistoryPage {
  tip: string;
  commits: CommitSummary[];
  nextOffset?: number;
}

export interface CommitDetails {
  oid: string;
  parent?: string;
  message: string;
  files: { status: string; path: string; originalPath?: string }[];
}

export interface CommitDiff {
  path: string;
  before: string;
  after: string;
  reason?: string;
}

export interface PanelState {
  repo?: string;
  selected?: string;
  drafts: Record<string, { text: string; token: string }>;
  messages: Record<string, string>;
}

export interface FileToken {
  change: Change;
  token: string;
}

// The webview adds requestId and clientId when sending a request.
export type Request =
  | { type: "refresh" | "restoreState" }
  | { type: "persistState"; state: PanelState }
  | { type: "openDraft"; text: string }
  | { type: "load" | "openFile"; change: Change }
  | ({ type: "save" | "resolve"; text: string } & FileToken)
  | ({ type: "stage" | "unstage" | "revert"; text?: string } & FileToken)
  | ({ type: "stageHunk" | "unstageHunk"; hunk: string } & FileToken)
  | { type: "revertBatch"; files: FileToken[] }
  | { type: "stageSelection" | "unstageSelection"; files: FileToken[]; indexTokens: { repo: string; token: string }[] }
  | { type: "stageBatch" | "unstageBatch"; repo: string; files: FileToken[]; indexToken: string }
  | { type: "branches"; repo: string }
  | { type: "switchBranch"; repo: string; ref: string; token: string }
  | { type: "history"; repo: string; tip?: string; offset?: number }
  | { type: "commitDetails"; repo: string; oid: string }
  | { type: "commitDiff"; repo: string; oid: string; path: string }
  | { type: "commit" | "commitPush"; repo: string; message: string; indexToken: string }
  | { type: "pull" | "push" | "fetch"; repo: string; indexToken: string };

export type Response =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "mode"; conflicts: boolean }
  | { type: "focus"; repo?: string; change?: string }
  | {
      type: "result";
      requestId: number;
      clientId?: string;
      error?: string;
      state?: PanelState;
      snapshot?: Snapshot;
      file?: FileView;
      branches?: BranchList;
      history?: HistoryPage;
      commitDetails?: CommitDetails;
      commitDiff?: CommitDiff;
      committed?: boolean;
    };
