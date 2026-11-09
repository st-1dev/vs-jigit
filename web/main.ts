import * as monaco from "monaco-editor/editor/editor.api";
import "../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/languages/definitions/typescript/register";
import "monaco-editor/languages/definitions/javascript/register";
import "monaco-editor/languages/definitions/go/register";
import "monaco-editor/languages/definitions/python/register";
import "monaco-editor/languages/definitions/rust/register";
import "monaco-editor/languages/definitions/java/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/yaml/register";
import "monaco-editor/languages/definitions/markdown/register";
import "monaco-editor/languages/definitions/html/register";
import "monaco-editor/languages/definitions/css/register";
import "monaco-editor/languages/definitions/sql/register";
import {
  Change,
  BranchList,
  CommitDetails,
  HistoryPage,
  FileView,
  Repository,
  PanelState,
  Request,
  Response,
  Snapshot,
} from "../shared/protocol";
import {
  Conflict,
  hasConflictMarkers,
  parseConflicts,
} from "../shared/conflicts";
import { GraphRow, layoutHistoryGraph } from "../shared/historyGraph";
import "./style.css";

type Persisted = PanelState;
declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): Persisted | undefined;
  setState(state: Persisted): void;
};
const vscode = acquireVsCodeApi();
monaco.languages.register({ id: "json", extensions: [".json", ".jsonc"] });
monaco.languages.setMonarchTokensProvider("json", {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "attribute.name"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/[{}[\],:]/, "delimiter"],
    ],
  },
});
const localState = vscode.getState();
const persisted: Persisted = { drafts: {}, messages: {}, ...localState };
let stateReady = false;
const workerUri = document.querySelector<HTMLScriptElement>(
  "script[data-worker]",
)!.dataset.worker!;
let workerBlob: Promise<string> | undefined;
(
  self as unknown as { MonacoEnvironment: monaco.Environment }
).MonacoEnvironment = {
  getWorker: async () => {
    workerBlob ??= fetch(workerUri).then(async (response) => {
      if (!response.ok)
        throw new Error("Could not load the local editor worker.");
      return URL.createObjectURL(
        new Blob([await response.text()], { type: "text/javascript" }),
      );
    });
    return new Worker(await workerBlob);
  },
};

const icons = {
  logo: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" aria-hidden="true">
  <g fill="currentColor">
    <path d="M17 13V7l2-2 2 1 2-1 2 1 2-1 2 2v6Z"/>
    <circle cx="23" cy="17" r="4"/>
    <path d="M20 23c2-2 5-1 6 1l4 11-7 5-6-3 3-8Z"/>
    <path d="M10 36c6-2 12 3 19 0l4-9 3-3 1 4 5 3-1 5-6-1-3 10-5 2H15l-5-4Z"/>
  </g>
  <g stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d="m25 25 7-5 5 4M24 37l-3 9 5 4M11 38c-5-2-6 3-7 7M14 45l-4 11H6m15-10-3 10m10-12 7 5 4 6h4m-11-15 8 4 4 7"/>
    <path d="M37 24c7 9 20 9 23-4C65 1 42 1 40 13c-1 6 4 12 12 13" stroke-width="2.5"/>
    <path d="M49 23v-9m0 5 7-5" stroke-width="2.5"/>
  </g>
  <g fill="currentColor">
    <circle cx="49" cy="12" r="2.5"/>
    <circle cx="56" cy="12" r="2.5"/>
    <circle cx="49" cy="23" r="2.5"/>
  </g>
</svg>`,
  refresh:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 8a6 6 0 1 0 0 5M16 3v5h-5"/></svg>',
  branch:
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4" cy="3" r="1.5"/><circle cx="12" cy="3" r="1.5"/><circle cx="4" cy="13" r="1.5"/><path d="M4 4.5v7M12 4.5c0 4-8 2-8 6"/></svg>',
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id)! as T;
const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
$("app").innerHTML = `
<header class="topbar"><div class="brand">${icons.logo}<span>Ji<span class="brand-light">Git</span></span><span class="preview">PREVIEW</span></div><div class="workspace-info" id="workspace-info">Connecting to Git…</div><button id="refresh" class="icon-button" title="Refresh repositories" aria-label="Refresh repositories">${icons.refresh}</button></header>
<nav class="tabs" aria-label="Workspace view"><button id="changes-tab" class="tab active">Changes <span id="changes-count">0</span></button><button id="conflicts-tab" class="tab">Conflicts <span id="conflicts-count">0</span></button><span class="tab-hint">One workspace. Every repository.</span></nav>
<div id="notice" role="status" hidden><span id="notice-text"></span><button id="dismiss" aria-label="Dismiss notification">×</button></div>
<main class="workspace"><aside class="sidebar"><div class="sidebar-tools"><select id="repo-filter" aria-label="Filter by repository"><option value="">All repositories</option></select><input id="search" type="search" placeholder="Filter files…" aria-label="Filter files"></div><div id="files" class="files" aria-label="Changed files"></div><section class="commit"><div class="section-caption">COMMIT &amp; SYNC</div><label class="sr-only" for="commit-repo">Repository for commit, sync, branches and history</label><div class="repository-controls"><select id="commit-repo"></select><button id="history" title="Browse commits in the selected repository">History…</button><button id="branches" title="View and switch branches in the selected repository">Branches…</button></div><div id="commit-summary" class="muted"></div><textarea id="commit-message" rows="3" placeholder="Commit message…" aria-label="Commit message"></textarea><div class="commit-buttons"><button id="commit" class="primary">Commit</button><button id="commit-push" class="primary">Commit &amp; Push</button></div><div id="sync-summary" class="muted" aria-live="polite"></div><div class="sync-buttons"><button id="fetch" title="Fetch all remotes without changing working files">Fetch</button><button id="pull" title="Pull the upstream branch (fast-forward only)">↓ Pull</button><button id="push" title="Push this branch; retry after a failed Commit &amp; Push">↑ Push</button></div><button id="drafts" title="Recover or discard saved drafts">Drafts (0)</button><div class="commit-note">Selected repository · Pull: fast-forward only</div></section></aside>
<section class="review"><div id="empty" class="empty"><div class="empty-icon">${icons.logo}</div><h1>Your changes, in one place.</h1><p>Select a file to review its diff.<br>Resolve conflicts with both sides in view.</p><div class="empty-shortcuts"><kbd>Ctrl / ⌘ S</kbd> Save draft <span>·</span> <kbd>Alt ↓ / ↑</kbd> Next / previous change</div></div>
<div id="file-view" hidden><header class="file-heading"><div class="file-identity"><span id="file-status" class="status"></span><div><strong id="file-name"></strong><div id="file-path" class="muted"></div></div></div><span id="draft-state" class="muted"></span><button id="reload" title="Reload from disk; discard this file's draft">Reload</button><button id="open-file">Open file ↗</button></header>
<div class="review-toolbar"><div class="toolbar-group"><button id="prev-change" title="Previous change (Alt+Up)" aria-label="Previous change">↑</button><button id="next-change" title="Next change (Alt+Down)" aria-label="Next change">↓</button><span id="diff-summary" class="muted" aria-live="polite"></span></div><div class="toolbar-group" id="diff-options"><label><input type="checkbox" id="inline"> Inline</label><label><input type="checkbox" id="context" checked> Collapse context</label><label><input type="checkbox" id="whitespace"> Ignore whitespace</label></div><div class="toolbar-group" id="merge-actions" hidden><button id="accept-yours" title="Accept Yours for the selected conflict block">Yours →</button><button id="accept-both" title="Accept Yours followed by Theirs for the selected block">Both</button><button id="accept-theirs" title="Accept Theirs for the selected conflict block">← Theirs</button></div><div class="toolbar-group"><button id="save">Save</button><button id="stage" class="primary">Stage file</button><button id="unstage">Unstage file</button><button id="resolve" class="primary">Mark resolved</button></div></div>
<div id="unsupported" class="unsupported" hidden></div>
<div id="hunk-actions" class="hunk-actions" hidden><label for="hunk-select">Git block</label><select id="hunk-select" aria-label="Git block"></select><button id="show-hunk">Show block</button><button id="move-hunk" class="primary">Stage block</button><span id="hunk-help" class="muted"></span></div>
<div id="diff-labels" class="pane-labels"><span id="before-label"></span><span id="after-label"></span></div><div id="diff-editor" class="editor-host"></div>
<div id="merge-labels" class="merge-labels" hidden><span><i class="dot yours"></i>Yours <small>Git stage 2</small></span><span><i class="dot result"></i>Result <small>editable · undo supported</small></span><span><i class="dot theirs"></i>Theirs <small>Git stage 3</small></span></div>
<div id="merge-editors" class="merge-editors" hidden><div id="yours-editor"></div><div id="result-editor"></div><div id="theirs-editor"></div></div>
<footer class="review-footer"><span id="review-help"></span><span id="encoding">UTF-8</span></footer></div></section></main>
<dialog id="history-dialog" aria-labelledby="history-title"><h2 id="history-title">Commit history</h2><p id="history-repo"></p><p id="history-status" role="status">Loading history…</p><div class="history-layout"><section class="history-sidebar"><input id="history-search" type="search" placeholder="Filter loaded commits…" aria-label="Filter loaded commits"><p id="history-graph-note" class="muted"></p><div id="history-list" aria-label="Commits"></div><button id="history-more">Load more</button></section><section class="history-review"><div class="history-details"><pre id="history-message">Select a commit to review its changes.</pre><p id="history-parent"></p><div id="history-files" aria-label="Commit files"></div></div><p id="history-diff-label">Select a file · read-only</p><div id="history-diff"></div></section></div><div class="history-footer"><button id="refresh-history">Refresh history</button><button id="close-history">Close</button></div></dialog>
<dialog id="branches-dialog" aria-labelledby="branches-title"><h2 id="branches-title">Branches</h2><p id="branches-repo"></p><input id="branch-search" type="search" placeholder="Filter branches…" aria-label="Filter branches"><p id="branch-status" role="status">Switching requires a clean repository and saved drafts.</p><div id="branch-list"></div><div><button id="refresh-branches">Refresh branches</button><button id="close-branches">Close</button></div></dialog>
<div id="file-menu" role="menu" aria-label="File actions" data-vscode-context='{"preventDefaultContextMenuItems":true}' hidden><button id="stage-files" role="menuitem">Stage</button><button id="unstage-files" role="menuitem">Unstage</button><button id="revert-file" role="menuitem">Revert…</button></div>
<dialog id="revert-dialog" aria-labelledby="revert-title"><h2 id="revert-title">Revert this file?</h2><p id="revert-path"></p><p id="revert-help"></p><div><button id="cancel-revert">Cancel</button><button id="confirm-revert" class="primary">Revert</button></div></dialog>
<dialog id="discard-dialog"><h2>Reload this file?</h2><p>This discards your unsaved JiGit draft and loads the current file from disk.</p><div><button id="cancel-discard">Keep draft</button><button id="confirm-discard" class="primary">Reload from disk</button></div></dialog>
<dialog id="drafts-dialog"><h2>Unsaved drafts</h2><p>Drafts are stored in this workspace. Open a copy in VS Code to recover its text.</p><div id="draft-list"></div><button id="close-drafts">Close</button></dialog>
<dialog id="delete-draft-dialog"><h2>Discard this draft?</h2><p>The unsaved text will be removed from JiGit.</p><button id="keep-draft">Keep draft</button><button id="delete-draft">Discard draft</button></dialog>`;

let snapshot: Snapshot = { repositories: [] };
let selectedRepo = persisted.repo || "";
let commitRepo = selectedRepo;
let conflictsOnly = false;
let file: FileView | undefined;
const selectedFiles = new Set<string>();
let selectionAnchor: string | undefined;
let busy = false;
let historyRepo = "";
let historyPage: HistoryPage | undefined;
let historyDetails: CommitDetails | undefined;
let historyDiff: monaco.editor.IStandaloneDiffEditor | undefined;
let historyModels: monaco.editor.ITextModel[] = [];
let branchRepo = "";
let branchList: BranchList | undefined;
let loadGeneration = 0;
let currentConflict = 0;
let diff: monaco.editor.IStandaloneDiffEditor | undefined;
let hunkHighlights: monaco.editor.IEditorDecorationsCollection[] = [];
let result: monaco.editor.IStandaloneCodeEditor | undefined;
let yours: monaco.editor.IStandaloneCodeEditor | undefined;
let theirs: monaco.editor.IStandaloneCodeEditor | undefined;
let disposables: monaco.IDisposable[] = [];
let models: monaco.editor.ITextModel[] = [];
let zones: string[] = [];
let decorations: monaco.editor.IEditorDecorationsCollection | undefined;
let sequence = 0;
const clientId = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-");
let dragged: Change | undefined;
const pending = new Map<
  number,
  {
    data: Request;
    resolve: (response: Extract<Response, { type: "result" }>) => void;
    reject: (error: Error) => void;
  }
>();
function request(
  data: Request,
): Promise<Extract<Response, { type: "result" }>> {
  return new Promise((resolve, reject) => {
    const requestId = ++sequence;
    pending.set(requestId, { data, resolve, reject });
    vscode.postMessage({ ...data, requestId, clientId });
  });
}
function persist() {
  persisted.repo = selectedRepo;
  persisted.selected = file?.change.id;
  vscode.setState(persisted);
  if (stateReady) void request({ type: "persistState", state: persisted }).catch((error) => notify(`Could not back up drafts: ${error}`, true));
}
function notify(message: string, error = false) {
  $("notice").hidden = false;
  $("notice").classList.toggle("error", error);
  $("notice-text").textContent = message;
  if ($<HTMLDialogElement>("history-dialog").open) $("history-status").textContent = message;
  if ($<HTMLDialogElement>("branches-dialog").open) $("branch-status").textContent = message;
}
async function task(action: () => Promise<void>) {
  if (busy) return;
  ++loadGeneration;
  busy = true;
  syncControls();
  try {
    await action();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), true);
  } finally {
    busy = false;
    syncControls();
  }
}
function draftText(): string {
  return (
    (result?.getModel() || diff?.getModifiedEditor().getModel())?.getValue() ??
    file?.after ??
    ""
  );
}
function dirty(): boolean {
  return !!file && !!persisted.drafts[file.change.id];
}
function recordDraft() {
  if (!file) return;
  const value = draftText();
  // Compare through a model to account for BOM and Monaco's EOL normalization.
  const original = file.after.replace(/^\uFEFF/, "");
  if (value === original) delete persisted.drafts[file.change.id];
  else persisted.drafts[file.change.id] = { text: value, token: file.token };
  persist();
  syncControls();
  renderFiles();
}
function applySnapshot(next: Snapshot) {
  snapshot = next;
  if (
    selectedRepo &&
    !snapshot.repositories.some((repo) => repo.id === selectedRepo)
  )
    selectedRepo = "";
  if (!snapshot.repositories.some((repo) => repo.id === commitRepo))
    commitRepo = selectedRepo || snapshot.repositories[0]?.id || "";
  const options = snapshot.repositories
    .map(
      (repo) =>
        `<option value="${escape(repo.id)}">${escape(repo.name)} · ${escape(repo.branch)}</option>`,
    )
    .join("");
  $("repo-filter").innerHTML =
    `<option value="">All repositories</option>${options}`;
  ($("repo-filter") as HTMLSelectElement).value = selectedRepo;
  $("commit-repo").innerHTML = options;
  ($("commit-repo") as HTMLSelectElement).value = commitRepo;
  $("workspace-info").textContent =
    `${snapshot.repositories.length} ${snapshot.repositories.length === 1 ? "repository" : "repositories"} connected`;
  const changes = snapshot.repositories.flatMap((repo) => repo.changes);
  $("changes-count").textContent = String(
    changes.filter((change) => change.group !== "conflict").length,
  );
  const conflicts = changes.filter(
    (change) => change.group === "conflict",
  ).length;
  $("conflicts-count").textContent = String(conflicts);
  $("conflicts-tab").classList.toggle("has-conflicts", conflicts > 0);
  renderFiles();
  renderCommit();
  syncControls();
}
function renderFiles() {
  closeFileMenu();
  const query = ($("search") as HTMLInputElement).value.toLowerCase();
  const groups = conflictsOnly
    ? (["conflict"] as const)
    : (["conflict", "working", "staged"] as const);
  const names = {
    conflict: "Conflicts",
    working: "Local changes",
    staged: "Staged changes",
  };
  let count = 0;
  const batches: Change[][] = [];
  $("files").innerHTML = snapshot.repositories
    .filter((repo) => !selectedRepo || repo.id === selectedRepo)
    .map((repo) => {
      const sections = groups
        .map((group) => {
          const changes = repo.changes.filter(
            (change) =>
              change.group === group &&
              `${change.path} ${repo.name}`.toLowerCase().includes(query),
          );
          count += changes.length;
          if (!changes.length && group === "conflict") return "";
          const batchId = batches.push(changes) - 1;
          const batchControls = group === "conflict" || !changes.length ? "" : `<button class="batch-move" data-batch="${batchId}" title="${group === "working" ? "Stage" : "Unstage"} all visible files in this group" ${busy || changes.some(hasDraft) ? "disabled" : ""}>${group === "working" ? "Stage" : "Unstage"} all</button>`;
          return `<div class="change-group" data-repo="${escape(repo.id)}" data-group="${group}"><div class="group-heading ${group}">${batchControls}<span>${names[group]} · ${changes.length}</span></div>${!changes.length ? '<div class="drop-hint">Drop files here</div>' : ""}${changes
            .map((change) => {
              const slash = change.path.lastIndexOf("/"),
                name = change.path.slice(slash + 1),
                dir = change.path.slice(0, slash + 1);
              return `<div class="file-item" data-item="${escape(change.id)}" draggable="${!busy && group !== "conflict" && !hasDraft(change)}"><button class="file-row" data-change="${escape(change.id)}" title="${escape(change.originalPath ? `${change.originalPath} → ${change.path}` : change.path)} · Ctrl/⌘+click to select · Shift+click for range${group === "conflict" ? "" : ` · Double-click to ${group === "working" ? "stage" : "unstage"} · Right-click for actions`}" ${busy ? "disabled" : ""}><span class="status status-${group === "conflict" ? "conflict" : change.status}">${group === "conflict" ? "!" : escape(change.status)}</span><span class="row-path"><span>${escape(name)}</span><small>${escape(dir || "./")}</small></span>${persisted.drafts[change.id] ? '<i class="draft-dot" title="Unsaved draft"></i>' : ""}</button>${group === "conflict" ? "" : `<button class="file-stage" data-move="${escape(change.id)}" title="${hasDraft(change) ? "Save or reload this file's draft before moving it" : group === "working" ? "Stage file" : "Unstage file"}" aria-label="${group === "working" ? "Stage" : "Unstage"} ${escape(change.path)}" ${busy || hasDraft(change) ? "disabled" : ""}>${group === "working" ? "+" : "−"}</button>`}</div>`;
            })
            .join("")}</div>`;
        })
        .join("");
      return `<section class="repository"><div class="repo-heading" title="${escape(repo.root)}"><span class="repo-symbol">▱</span><strong>${escape(repo.name)}</strong><button class="repo-branch" data-branches="${escape(repo.id)}" title="View and switch branches in ${escape(repo.name)}" ${busy || repo.error ? "disabled" : ""}>${icons.branch}${escape(repo.branch)}</button></div>${repo.error ? `<p class="repo-error">${escape(repo.error)}</p>` : sections || '<p class="repo-clean">No matching changes</p>'}</section>`;
    })
    .join("");
  if (!snapshot.repositories.length)
    $("files").innerHTML =
      '<div class="list-empty"><strong>No repositories yet</strong><p>Open a folder with Git, or add repositories to your VS Code workspace. JiGit follows the built-in Git discovery.</p></div>';
  else if (!count && conflictsOnly)
    $("files").insertAdjacentHTML(
      "beforeend",
      '<div class="list-empty"><strong>No conflicts to resolve</strong><p>Your repositories are ready for the next change.</p></div>',
    );
  $("files").querySelectorAll<HTMLButtonElement>("[data-branches]").forEach((button) => {
    button.onclick = () => void openBranches(button.dataset.branches!);
  });
  $("files").querySelectorAll<HTMLButtonElement>("[data-batch]").forEach((button) => {
    button.onclick = () => void moveFiles(batches[Number(button.dataset.batch)]);
  });
  const visible = new Set(visibleChanges().map((change) => change.id));
  for (const id of selectedFiles) if (!visible.has(id)) selectedFiles.delete(id);
  if (!visible.has(selectionAnchor || "")) selectionAnchor = undefined;
  updateSelection();
  $("files").querySelectorAll<HTMLButtonElement>("[data-change]").forEach((button) => {
    button.onclick = (event) => {
      const change = findChange(button.dataset.change);
      if (change && event.detail < 2) {
        selectRow(change, event);
        if (selectedFiles.has(change.id)) void selectFile(change);
      }
    };
    button.ondblclick = (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const change = findChange(button.dataset.change);
      if (change && change.group !== "conflict") void moveFile(change);
    };
    button.oncontextmenu = (event) => {
      event.preventDefault();
      const change = findChange(button.dataset.change);
      if (!busy && change && change.group !== "conflict") {
        if (!selectedFiles.has(change.id)) selectRow(change);
        openFileMenu(event, button);
      }
    };
  });
  $("files").querySelectorAll<HTMLButtonElement>("[data-move]").forEach((button) => {
    button.onclick = () => {
      const change = findChange(button.dataset.move);
      if (change) void moveFile(change);
    };
  });
  $("files").querySelectorAll<HTMLElement>("[data-item]").forEach((row) => {
    row.ondragstart = (event) => {
      const change = findChange(row.dataset.item);
      if (busy || !change || change.group === "conflict" || hasDraft(change)) {
        event.preventDefault();
        return;
      }
      dragged = change;
      event.dataTransfer!.effectAllowed = "move";
      event.dataTransfer!.setData("application/x-vs-jigit-change", change.id);
    };
    row.ondragend = clearDrop;
  });
  $("files").querySelectorAll<HTMLElement>(".change-group").forEach((group) => {
    const accepts = () => !busy && dragged && !hasDraft(dragged) &&
      group.dataset.repo === dragged.repo && group.dataset.group !== "conflict" &&
      group.dataset.group !== dragged.group;
    group.ondragover = (event) => {
      if (!accepts()) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "move";
      group.classList.add("drop-target");
    };
    group.ondragleave = (event) => {
      if (!group.contains(event.relatedTarget as Node | null)) group.classList.remove("drop-target");
    };
    group.ondrop = (event) => {
      event.preventDefault();
      const change = accepts() ? dragged : undefined;
      clearDrop();
      if (change) void moveFile(change);
    };
  });
}
function clearDrop() {
  dragged = undefined;
  document.querySelectorAll(".drop-target").forEach((group) => group.classList.remove("drop-target"));
}
function visibleChanges(): Change[] {
  return Array.from($("files").querySelectorAll<HTMLElement>("[data-change]"))
    .map((row) => findChange(row.dataset.change)).filter((change): change is Change => !!change);
}
function updateSelection() {
  $("files").querySelectorAll<HTMLElement>("[data-change]").forEach((row) => {
    const selected = selectedFiles.has(row.dataset.change!);
    row.classList.toggle("selected", selected);
    row.setAttribute("aria-pressed", String(selected));
    row.classList.toggle("previewed", row.dataset.change === file?.change.id);
  });
}
function selectRow(change: Change, event?: MouseEvent) {
  const additive = event?.ctrlKey || event?.metaKey;
  if (event?.shiftKey && selectionAnchor) {
    const ids = visibleChanges().map((item) => item.id);
    const start = ids.indexOf(selectionAnchor), end = ids.indexOf(change.id);
    if (!additive) selectedFiles.clear();
    for (const id of ids.slice(Math.min(start, end), Math.max(start, end) + 1)) selectedFiles.add(id);
  } else {
    const remove = additive && selectedFiles.has(change.id);
    if (!additive) selectedFiles.clear();
    if (remove) selectedFiles.delete(change.id);
    else selectedFiles.add(change.id);
    selectionAnchor = change.id;
  }
  updateSelection();
}
let menuChanges: Change[] = [];
let menuAnchor: HTMLButtonElement | undefined;
let revertTargets: { change: Change; token: string }[] = [];
function closeFileMenu(restoreFocus = false) {
  $("file-menu").hidden = true;
  if (restoreFocus) menuAnchor?.focus();
  menuChanges = [];
}
function openFileMenu(event: MouseEvent, anchor: HTMLButtonElement) {
  menuChanges = visibleChanges().filter((change) => selectedFiles.has(change.id));
  menuAnchor = anchor;
  const menu = $("file-menu");
  for (const [id, group, label] of [["stage-files", "working", "Stage"], ["unstage-files", "staged", "Unstage"]]) {
    const targets = menuChanges.filter((change) => change.group === group);
    const button = $<HTMLButtonElement>(id);
    button.hidden = !targets.length;
    button.textContent = `${label}${targets.length > 1 ? ` ${targets.length} files` : ""}`;
    button.disabled = menuChanges.some((change) => change.group === "conflict") || targets.some(hasDraft);
    button.title = button.disabled ? "Save drafts and resolve conflicts before moving selected files" : `${label} selected files`;
  }
  const action = $<HTMLButtonElement>("revert-file");
  action.textContent = menuChanges.length > 1 ? `Revert ${menuChanges.length} changes…` : "Revert…";
  action.disabled = menuChanges.some((change) => hasDraft(change) || change.group === "conflict");
  action.title = action.disabled ? "Save drafts and resolve conflicts before reverting selected files" : "Revert selected changes…";
  menu.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const x = event.clientX || rect.left, y = event.clientY || rect.bottom;
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - menu.offsetWidth))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - menu.offsetHeight))}px`;
  menu.querySelector<HTMLButtonElement>("button:not([hidden]):not(:disabled)")?.focus();
}
document.addEventListener("pointerdown", (event) => {
  if (!$("file-menu").contains(event.target as Node)) closeFileMenu();
});
document.addEventListener("keydown", (event) => {
  if ($("file-menu").hidden) return;
  if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape") event.preventDefault();
    closeFileMenu(true);
  } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const actions = Array.from($("file-menu").querySelectorAll<HTMLButtonElement>("button:not([hidden]):not(:disabled)"));
    const index = actions.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? actions.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + actions.length) % actions.length;
    actions[next]?.focus();
  }
});
$("files").addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && !busy) {
    event.preventDefault();
    for (const change of visibleChanges()) selectedFiles.add(change.id);
    updateSelection();
  }
});
$("files").addEventListener("scroll", () => closeFileMenu());
window.addEventListener("resize", () => closeFileMenu());
for (const [id, group] of [["stage-files", "working"], ["unstage-files", "staged"]]) {
  $(id).onclick = () => {
    const changes = menuChanges.filter((change) => change.group === group);
    closeFileMenu();
    if (changes.length) void moveFiles(changes);
  };
}
$("revert-file").onclick = () => {
  // A partially staged file may be selected in both groups: HEAD wins.
  const targets = new Map<string, Change>();
  for (const change of menuChanges) {
    const key = JSON.stringify([change.repo, change.path]);
    if (!targets.has(key) || change.group === "staged") targets.set(key, change);
  }
  const changes = [...targets.values()];
  closeFileMenu();
  if (!changes.length) return;
  void task(async () => {
    if (changes.some(hasDraft)) throw new Error("Save or reload selected files' drafts before reverting them.");
    const loadedTargets: { change: Change; token: string }[] = [];
    for (const change of changes) {
      const target = file?.change.id === change.id ? file : (await request({ type: "load", change })).file;
      if (!target) throw new Error("A selected file is no longer available.");
      loadedTargets.push({ change: target.change, token: target.token });
    }
    revertTargets = loadedTargets;
    $("revert-title").textContent = changes.length === 1 ? "Revert this file?" : `Revert ${changes.length} files?`;
    $("revert-path").textContent = changes.map((change) => `${snapshot.repositories.find((repo) => repo.id === change.repo)?.name} · ${change.originalPath ? `${change.originalPath} → ` : ""}${change.path} (${change.group === "staged" ? "HEAD" : "index"})`).join("\n");
    $("revert-help").textContent = changes.length > 1
      ? "Local changes: restore the index version; staged changes will be kept. Staged changes: discard ALL staged and unstaged changes and restore HEAD. Untracked and added files will be deleted. This cannot be undone."
      : changes[0].group === "staged"
      ? "Discard ALL staged and unstaged changes to this file and restore HEAD. Added files will be deleted. This cannot be undone."
      : changes[0].status === "?" ? "Delete this untracked file from disk. This cannot be undone."
      : "Discard unstaged changes to this file and restore the index version. Staged changes will be kept. This cannot be undone.";
    $<HTMLDialogElement>("revert-dialog").showModal();
    $("cancel-revert").focus();
  });
};
$("cancel-revert").onclick = () => $<HTMLDialogElement>("revert-dialog").close();
$("revert-dialog").addEventListener("close", () => { revertTargets = []; });
$("confirm-revert").onclick = () => {
  const targets = revertTargets;
  revertTargets = [];
  $<HTMLDialogElement>("revert-dialog").close();
  if (!targets.length) return;
  void task(async () => {
    if (targets.some((target) => hasDraft(target.change))) throw new Error("Save or reload selected files' drafts before reverting them.");
    const response = await request({ type: "revertBatch", files: targets });
    if (response.snapshot) applySnapshot(response.snapshot);
    commitRepo = targets[0].change.repo;
    $<HTMLSelectElement>("commit-repo").value = commitRepo;
    renderCommit();
    // Index changes invalidate other clean comparisons in the same repository.
    if (file && targets.some((target) => target.change.repo === file!.change.repo) && !hasDraft(file.change)) {
      const next = snapshot.repositories.find((repo) => repo.id === file!.change.repo)?.changes.find((change) => change.id === file?.change.id);
      if (next) {
        const loaded = await request({ type: "load", change: next });
        if (loaded.file) showFile(loaded.file);
      } else clearFile();
    }
    persist();
    notify(targets.length === 1 ? "File reverted." : `${targets.length} files reverted.`);
  });
};
function findChange(id: string | undefined) {
  return snapshot.repositories.flatMap((repo) => repo.changes).find((change) => change.id === id);
}
function hasDraft(change: Change): boolean {
  return Object.keys(persisted.drafts).some((id) => {
    // A partially staged file can have a draft in its other group.
    const [repo, path] = JSON.parse(id) as string[];
    return repo === change.repo && (path === change.path || change.status === "R" && path === change.originalPath);
  });
}
function selectedCommitRepo(): Repository | undefined {
  return snapshot.repositories.find((repo) => repo.id === commitRepo);
}
function renderCommit() {
  const repo = selectedCommitRepo();
  const staged =
    repo?.changes.filter((change) => change.group === "staged").length || 0;
  $("sync-summary").textContent = repo ? repo.syncError || (repo.upstream
    ? `${repo.upstream} · ↑ ${repo.ahead ?? "?"} ahead · ↓ ${repo.behind ?? "?"} behind (last fetched)`
    : "No upstream configured") : "";
  $("commit-summary").textContent =
    `${staged} staged ${staged === 1 ? "file" : "files"}`;
  ($("commit-message") as HTMLTextAreaElement).value =
    persisted.messages[commitRepo] || "";
  syncControls();
}
function syncControls() {
  $("drafts").textContent = `Drafts (${Object.keys(persisted.drafts).length})`;
  const merge = file?.change.group === "conflict";
  const count = merge ? parseConflicts(draftText()).length : 0;
  ($("save") as HTMLButtonElement).disabled =
    busy || !file?.editable || !dirty();
  $("save").hidden = !file?.editable;
  $("stage").hidden = !file || file.change.group !== "working";
  ($("stage") as HTMLButtonElement).disabled = busy || !!file && hasDraft(file.change);
  $("unstage").hidden = !file || file.change.group !== "staged";
  ($("unstage") as HTMLButtonElement).disabled = busy || !!file && hasDraft(file.change);
  const hasHunks = !!file?.hunks?.length;
  $("hunk-actions").hidden = !hasHunks;
  const hunkBlocked = !!file && hasDraft(file.change) || $<HTMLInputElement>("whitespace").checked;
  $<HTMLButtonElement>("move-hunk").disabled = busy || !hasHunks || hunkBlocked;
  $<HTMLSelectElement>("hunk-select").disabled = busy || !hasHunks;
  $<HTMLButtonElement>("show-hunk").disabled = busy || !hasHunks || hunkBlocked;
  $("move-hunk").textContent = file?.change.group === "staged" ? "Unstage block" : "Stage block";
  $("hunk-help").textContent = file && hasDraft(file.change) ? "Save or reload the draft first" : $<HTMLInputElement>("whitespace").checked ? "Include whitespace to stage blocks" : "Up to 3 context lines";
  if (hunkBlocked) for (const highlight of hunkHighlights) highlight.clear();
  $("resolve").hidden = !merge;
  ($("resolve") as HTMLButtonElement).disabled =
    busy || !file?.editable || hasConflictMarkers(draftText());
  if (file) {
    $("draft-state").textContent = dirty()
      ? "● Unsaved draft"
      : file.change.group === "staged"
        ? "Index · read-only"
        : "Saved on disk";
    $("draft-state").classList.toggle("unsaved", dirty());
    if (merge)
      $("diff-summary").textContent =
        `${count ? `${currentConflict + 1}/${count} · ` : ""}${count} unresolved ${count === 1 ? "block" : "blocks"}`;
  }
  const repo = selectedCommitRepo();
  ($("commit") as HTMLButtonElement).disabled =
    busy ||
    !repo ||
    !repo.changes.some((change) => change.group === "staged") ||
    repo.changes.some((change) => change.group === "conflict") ||
    !($("commit-message") as HTMLTextAreaElement).value.trim();
  ($("commit-push") as HTMLButtonElement).disabled = ($("commit") as HTMLButtonElement).disabled;
  ($("fetch") as HTMLButtonElement).disabled = busy || !repo || !!repo.error;
  ($("pull") as HTMLButtonElement).disabled = busy || !repo || !!repo.error;
  ($("push") as HTMLButtonElement).disabled = busy || !repo || !!repo.error;
  $<HTMLButtonElement>("branches").disabled = busy || !repo || !!repo.error;
  for (const id of ["refresh-branches", "close-branches", "branch-search"])
    $<HTMLButtonElement>(id).disabled = busy;
  document.querySelectorAll<HTMLButtonElement>("[data-branches]").forEach((button) => {
    button.disabled = busy || !!snapshot.repositories.find((repo) => repo.id === button.dataset.branches)?.error;
  });
  renderBranches();
  $<HTMLButtonElement>("history").disabled = busy || !repo || !!repo.error;
  for (const id of ["close-history", "refresh-history", "history-search"])
    $<HTMLButtonElement>(id).disabled = busy;
  $<HTMLButtonElement>("history-more").disabled = busy || historyPage?.nextOffset === undefined;
  $("history-dialog").querySelectorAll<HTMLButtonElement>("[data-commit], [data-commit-file]").forEach((button) => { button.disabled = busy; });
  for (const id of [
    "drafts",
    "commit-message",
    "refresh",
    "reload",
    "open-file",
    "repo-filter",
    "commit-repo",
  ])
    $<HTMLButtonElement>(id).disabled = busy;
  $("app").classList.toggle("busy", busy);
  document
    .querySelectorAll<HTMLButtonElement>(".file-row, .conflict-actions button")
    .forEach((button) => {
      button.disabled = busy;
    });
  document.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((button) => {
    const change = findChange(button.dataset.move);
    button.disabled = busy || !change || hasDraft(change);
  });
  document.querySelectorAll<HTMLElement>("[data-item]").forEach((row) => {
    const change = findChange(row.dataset.item);
    row.draggable = !busy && !!change && change.group !== "conflict" && !hasDraft(change);
  });
  document
    .querySelectorAll<HTMLButtonElement>("#merge-actions button")
    .forEach((button) => {
      button.disabled = busy || count === 0;
    });
  document.querySelectorAll<HTMLButtonElement>("[data-batch]").forEach((button) => {
    const group = button.closest<HTMLElement>(".change-group")!;
    const visible = new Set(Array.from(group.querySelectorAll<HTMLElement>("[data-item]"), (row) => row.dataset.item));
    const changes = snapshot.repositories.find((repo) => repo.id === group.dataset.repo)?.changes.filter((change) => visible.has(change.id)) || [];
    button.disabled = busy || !changes.length || changes.some(hasDraft);
  });
  diff?.updateOptions({ readOnly: busy || !file?.editable });
  result?.updateOptions({ readOnly: busy || !file?.editable });
}
function language(file: string): string {
  const extension = file.split(".").pop()?.toLowerCase();
  return (
    (
      {
        ts: "typescript",
        tsx: "typescript",
        js: "javascript",
        jsx: "javascript",
        json: "json",
        go: "go",
        py: "python",
        rs: "rust",
        java: "java",
        sh: "shell",
        bash: "shell",
        yaml: "yaml",
        yml: "yaml",
        md: "markdown",
        html: "html",
        css: "css",
        sql: "sql",
      } as Record<string, string>
    )[extension || ""] || "plaintext"
  );
}
function editorOptions(): monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    automaticLayout: true,
    fontSize: 13,
    lineHeight: 21,
    fontFamily:
      'var(--vscode-editor-font-family, "SFMono-Regular", Consolas, monospace)',
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    padding: { top: 12, bottom: 12 },
    lineNumbersMinChars: 3,
    glyphMargin: false,
    renderLineHighlight: "gutter",
    fixedOverflowWidgets: true,
    wordWrap: "off",
    bracketPairColorization: { enabled: true },
  };
}
function theme() {
  const light = document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
  const highContrast =
    document.body.classList.contains("vscode-high-contrast") ||
    document.body.classList.contains("vscode-high-contrast-light");
  const style = getComputedStyle(document.body);
  const color = (name: string, fallback: string) =>
    style.getPropertyValue(`--vscode-${name}`).trim() || fallback;
  monaco.editor.defineTheme("vs-jigit", {
    base: highContrast
      ? light
        ? "hc-light"
        : "hc-black"
      : light
        ? "vs"
        : "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": color("editor-background", "#1e1f22"),
      "editor.foreground": color("editor-foreground", "#bcbec4"),
      "editorLineNumber.foreground": color(
        "editorLineNumber-foreground",
        "#62666f",
      ),
      "diffEditor.insertedTextBackground": "#4ca87530",
      "diffEditor.removedTextBackground": "#e36c6c28",
    },
  });
  monaco.editor.setTheme("vs-jigit");
}
theme();
new MutationObserver(theme).observe(document.body, {
  attributes: true,
  attributeFilter: ["class", "style"],
});

async function selectFile(change: Change, discard = false) {
  if (busy) return;
  const generation = ++loadGeneration;
  $("draft-state").textContent = "Loading…";
  try {
    const response = await request({ type: "load", change });
    if (generation !== loadGeneration || !response.file) return;
    if (discard) delete persisted.drafts[change.id];
    showFile(response.file);
    commitRepo = change.repo;
    ($("commit-repo") as HTMLSelectElement).value = commitRepo;
    renderCommit();
  } catch (error) {
    if (generation === loadGeneration) notify(String(error), true);
  }
}
function disposeEditors() {
  for (const disposable of disposables) disposable.dispose();
  disposables = [];
  diff?.dispose();
  result?.dispose();
  yours?.dispose();
  theirs?.dispose();
  diff = undefined;
  hunkHighlights = [];
  result = undefined;
  yours = undefined;
  theirs = undefined;
  yoursHighlight = undefined;
  theirsHighlight = undefined;
  for (const model of models) model.dispose();
  models = [];
  zones = [];
}
function model(text: string, fileName: string): monaco.editor.ITextModel {
  const next = monaco.editor.createModel(text, language(fileName));
  models.push(next);
  return next;
}
function showFile(next: FileView) {
  disposeEditors();
  file = next;
  currentConflict = 0;
  const merge = file.change.group === "conflict";
  const draft = persisted.drafts[file.change.id];
  let content = draft?.text ?? file.after;
  if (draft && draft.token !== file.token) {
    file = { ...file, token: draft.token };
    notify(
      "This file changed since your draft was created. Your draft is kept. Reload to review the current file before saving.",
      true,
    );
  }
  $("empty").hidden = true;
  $("file-view").hidden = false;
  $("file-name").textContent = file.change.path.split("/").pop()!;
  const repo = snapshot.repositories.find(
    (repo) => repo.id === file!.change.repo,
  );
  $("file-path").textContent =
    `${repo?.name || ""} / ${file.change.originalPath ? `${file.change.originalPath} → ` : ""}${file.change.path}`;
  $("file-status").textContent = merge ? "!" : file.change.status;
  $("file-status").className =
    `status status-${merge ? "conflict" : file.change.status}`;
  $("unsupported").hidden = !file.reason;
  $("unsupported").textContent = file.reason || "";
  $("diff-editor").hidden = merge || !!file.reason;
  $("diff-labels").hidden = merge || !!file.reason;
  $("merge-editors").hidden = !merge || !!file.reason;
  $("merge-labels").hidden = !merge || !!file.reason;
  $("diff-options").hidden = merge || !!file.reason;
  $("merge-actions").hidden = !merge || !!file.reason;
  if (!file.reason && merge) {
    yours = monaco.editor.create($("yours-editor"), {
      ...editorOptions(),
      model: model(file.yours || "", file.change.path),
      readOnly: true,
    });
    result = monaco.editor.create($("result-editor"), {
      ...editorOptions(),
      model: model(content, file.change.path),
    });
    theirs = monaco.editor.create($("theirs-editor"), {
      ...editorOptions(),
      model: model(file.theirs || "", file.change.path),
      readOnly: true,
    });
    decorations = result.createDecorationsCollection();
    disposables.push(
      result.onDidChangeModelContent(() => {
        recordDraft();
        renderConflicts();
      }),
    );
    disposables.push(
      result.onDidChangeCursorPosition((event) => {
        const blocks = parseConflicts(draftText());
        const index = blocks.findIndex(
          (block) =>
            event.position.lineNumber >= block.line &&
            event.position.lineNumber <= block.endLine,
        );
        if (index >= 0) {
          currentConflict = index;
          syncControls();
        }
      }),
    );
    renderConflicts();
    navigateConflict(0);
    $("review-help").textContent =
      "Choose each block, then review and mark resolved. During rebase, Yours = rebased-on branch; Theirs = replayed commit.";
  } else if (!file.reason) {
    diff = monaco.editor.createDiffEditor($("diff-editor"), {
      ...editorOptions(),
      readOnly: !file.editable,
      originalEditable: false,
      renderSideBySide: !($("inline") as HTMLInputElement).checked,
      useInlineViewWhenSpaceIsLimited: true,
      hideUnchangedRegions: {
        enabled: ($("context") as HTMLInputElement).checked,
      },
      ignoreTrimWhitespace: ($("whitespace") as HTMLInputElement).checked,
      diffAlgorithm: "advanced",
      renderMarginRevertIcon: false,
      enableSplitViewResizing: true,
    });
    diff.setModel({
      original: model(file.before, file.change.path),
      modified: model(content, file.change.path),
    });
    hunkHighlights = [diff.getOriginalEditor(), diff.getModifiedEditor()].map((editor) => editor.createDecorationsCollection());
    $("hunk-select").innerHTML = (file.hunks || []).map((hunk, index) => `<option value="${hunk.id}">Block ${index + 1} · ${escape(hunk.header)}</option>`).join("");
    showHunk(false);
    disposables.push(
      diff.getModifiedEditor().onDidChangeModelContent(recordDraft),
    );
    disposables.push(
      diff.onDidUpdateDiff(() => {
        const changes = diff?.getLineChanges() || [];
        let added = 0,
          removed = 0;
        for (const change of changes) {
          if (change.modifiedEndLineNumber)
            added +=
              change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
          if (change.originalEndLineNumber)
            removed +=
              change.originalEndLineNumber - change.originalStartLineNumber + 1;
        }
        $("diff-summary").innerHTML =
          `<span class="added">+${added}</span> <span class="removed">−${removed}</span> <span class="diff-blocks">${changes.length} ${changes.length === 1 ? "change" : "changes"}</span>`;
      }),
    );
    $("before-label").textContent =
      file.change.group === "staged"
        ? "HEAD · last commit"
        : "Index · staged version";
    $("after-label").textContent =
      file.change.group === "staged"
        ? "Index · staged version"
        : "Working copy · editable";
    $("review-help").textContent =
      file.change.group === "staged"
        ? "Review exactly what will go into your next commit."
        : "Edit the working copy here. Save before staging. Ctrl / ⌘ S to save.";
  } else {
    $("diff-summary").textContent = "Preview unavailable";
    $("review-help").textContent =
      "Use the built-in Git tools for this file type.";
  }
  $("encoding").textContent = content.includes("\r\n")
    ? "UTF-8 · CRLF"
    : "UTF-8 · LF";
  // Preserve row nodes during selection so the browser can deliver a double-click.
  $("files").querySelectorAll<HTMLButtonElement>("[data-change]").forEach((button) => {
    button.classList.toggle("previewed", button.dataset.change === file?.change.id);
    const dot = button.querySelector(".draft-dot");
    if (!persisted.drafts[button.dataset.change!]) dot?.remove();
    else if (!dot) button.insertAdjacentHTML("beforeend", '<i class="draft-dot" title="Unsaved draft"></i>');
  });
  syncControls();
  persist();
}

function renderConflicts() {
  if (!result) return;
  const blocks = parseConflicts(draftText());
  currentConflict = Math.min(currentConflict, Math.max(0, blocks.length - 1));
  decorations?.set(
    blocks.map((block) => ({
      range: new monaco.Range(block.line, 1, block.endLine, 1),
      options: {
        isWholeLine: true,
        className: "conflict-line",
        linesDecorationsClassName: "conflict-gutter",
        overviewRuler: {
          color: "#d9a35b",
          position: monaco.editor.OverviewRulerLane.Full,
        },
      },
    })),
  );
  result.changeViewZones((accessor) => {
    zones.forEach((id) => accessor.removeZone(id));
    zones = [];
    blocks.forEach((block, index) => {
      const node = document.createElement("div");
      node.className = "conflict-actions";
      node.onpointerdown = (event) => event.stopPropagation();
      node.onmousedown = (event) => event.stopPropagation();
      const label = document.createElement("span");
      label.textContent = `Block ${index + 1}`;
      node.append(label);
      for (const [choice, caption] of [
        ["yours", "Accept Yours →"],
        ["both", "Accept Both"],
        ["theirs", "← Accept Theirs"],
      ] as const) {
        const button = document.createElement("button");
        button.textContent = caption;
        button.disabled = busy;
        button.onmousedown = (event) => event.preventDefault();
        button.onclick = (event) => {
          event.stopPropagation();
          acceptBlock(index, choice);
        };
        node.append(button);
      }
      zones.push(
        accessor.addZone({
          afterLineNumber: block.line - 1,
          heightInPx: 32,
          domNode: node,
          suppressMouseDown: true,
        }),
      );
    });
  });
}
function acceptBlock(index: number, choice: "yours" | "theirs" | "both") {
  if (!result || busy) return;
  const text = draftText(),
    block = parseConflicts(text)[index];
  if (!block) return;
  const replacement =
    choice === "both" ? block.yours + block.theirs : block[choice];
  const model = result.getModel()!;
  const start = model.getPositionAt(block.start),
    end = model.getPositionAt(block.end);
  result.pushUndoStop();
  result.executeEdits("accept-conflict", [
    {
      range: new monaco.Range(
        start.lineNumber,
        start.column,
        end.lineNumber,
        end.column,
      ),
      text: replacement,
    },
  ]);
  result.pushUndoStop();
  result.focus();
  navigateConflict(0);
}
function highlightSide(
  editor: monaco.editor.IStandaloneCodeEditor | undefined,
  content: string,
  className: string,
) {
  if (!editor || !content.trim()) return;
  const match = editor
    .getModel()!
    .findMatches(
      content.trimEnd().replace(/\r\n/g, "\n"),
      false,
      false,
      false,
      null,
      false,
    )[0];
  const collection = editor === yours ? yoursHighlight : theirsHighlight;
  collection?.clear();
  if (match) {
    collection?.set([
      { range: match.range, options: { isWholeLine: true, className } },
    ]);
    editor.revealLineInCenter(match.range.startLineNumber);
  }
}
let yoursHighlight: monaco.editor.IEditorDecorationsCollection | undefined;
let theirsHighlight: monaco.editor.IEditorDecorationsCollection | undefined;
function navigateConflict(delta: number) {
  const blocks = parseConflicts(draftText());
  if (!blocks.length || !result) return;
  currentConflict = (currentConflict + delta + blocks.length) % blocks.length;
  const block: Conflict = blocks[currentConflict];
  result.setPosition({ lineNumber: block.line, column: 1 });
  result.revealLineInCenter(block.line);
  yoursHighlight ??= yours?.createDecorationsCollection();
  theirsHighlight ??= theirs?.createDecorationsCollection();
  highlightSide(yours, block.yours, "yours-line");
  highlightSide(theirs, block.theirs, "theirs-line");
  syncControls();
}

function setMode(conflicts: boolean) {
  conflictsOnly = conflicts;
  $("changes-tab").classList.toggle("active", !conflicts);
  $("conflicts-tab").classList.toggle("active", conflicts);
  renderFiles();
}
$("changes-tab").onclick = () => setMode(false);
$("conflicts-tab").onclick = () => setMode(true);
$("search").oninput = renderFiles;
$("repo-filter").onchange = () => {
  selectedRepo = ($("repo-filter") as HTMLSelectElement).value;
  if (selectedRepo) {
    commitRepo = selectedRepo;
    ($("commit-repo") as HTMLSelectElement).value = commitRepo;
    renderCommit();
  }
  renderFiles();
  persist();
};
$("commit-repo").onchange = () => {
  commitRepo = ($("commit-repo") as HTMLSelectElement).value;
  renderCommit();
};
$("commit-message").oninput = () => {
  persisted.messages[commitRepo] = (
    $("commit-message") as HTMLTextAreaElement
  ).value;
  persist();
  syncControls();
};
function clearFile() {
  disposeEditors();
  file = undefined;
  $("file-view").hidden = true;
  $("empty").hidden = false;
  renderFiles();
  persist();
}
function finishCommit(repo: Repository) {
  delete persisted.messages[repo.id];
  if (file?.change.repo === repo.id && file.change.group === "staged") clearFile();
  renderCommit();
  persist();
}
function commit(type: "commit" | "commitPush") {
  return task(async () => {
    const repo = selectedCommitRepo();
    if (!repo) return;
    const response = await request({
      type,
      repo: repo.id,
      message: ($("commit-message") as HTMLTextAreaElement).value,
      indexToken: repo.indexToken,
    });
    if (response.snapshot) applySnapshot(response.snapshot);
    if (response.committed) finishCommit(repo);
    notify(type === "commitPush"
      ? `Committed and pushed staged changes in ${repo.name}.`
      : `Committed staged changes in ${repo.name}.`);
  });
}
$("commit").onclick = () => void commit("commit");
$("commit-push").onclick = () => void commit("commitPush");
function synchronize(type: "pull" | "push" | "fetch") {
  return task(async () => {
    const repo = selectedCommitRepo();
    if (!repo) return;
    if (type === "pull" && Object.keys(persisted.drafts).some((id) => JSON.parse(id)[0] === repo.id))
      throw new Error("Save or reload JiGit drafts in this repository before pulling.");
    const response = await request({ type, repo: repo.id, indexToken: repo.indexToken });
    if (response.snapshot) applySnapshot(response.snapshot);
    if (type === "pull" && file?.change.repo === repo.id) clearFile();
    notify(`${type === "pull" ? "Pulled upstream changes into" : type === "fetch" ? "Fetched remotes for" : "Pushed branch in"} ${repo.name}.`);
  });
}
$("fetch").onclick = () => void synchronize("fetch");
$("pull").onclick = () => void synchronize("pull");
$("push").onclick = () => void synchronize("push");
function disposeHistoryDiff() {
  historyDiff?.dispose();
  historyDiff = undefined;
  for (const model of historyModels) model.dispose();
  historyModels = [];
}
function clearHistoryDetails() {
  disposeHistoryDiff();
  historyDetails = undefined;
  $("history-message").textContent = "Select a commit to review its changes.";
  $("history-parent").textContent = "";
  $("history-files").replaceChildren();
  $("history-diff-label").textContent = "Select a file · read-only";
}
const historyRowHeight = 64;
const graphX = (lane: number) => 10 + lane * 14;
function historyGraphSvg(row: GraphRow, width: number, merge: boolean): string {
  const edges = row.edges.map((edge) => {
    const from = graphX(edge.from), to = graphX(edge.to);
    const start = edge.start === "top" ? 0 : historyRowHeight / 2;
    const end = edge.end === "node" ? historyRowHeight / 2 : historyRowHeight;
    const path = edge.end === "node" ? `M ${from} ${start} L ${to} ${end}`
      : `M ${from} ${start} L ${from} 32 C ${from} 52 ${to} 52 ${to} ${end}`;
    return `<path class="graph-color-${edge.color % 6}${edge.boundary ? " graph-boundary" : ""}" d="${path}"/>`;
  }).join("");
  return `<svg class="history-graph" style="width: ${width}px" width="${width}" height="${historyRowHeight}" viewBox="0 0 ${width} ${historyRowHeight}" aria-hidden="true" focusable="false">${edges}<circle class="history-graph-node graph-color-${row.color % 6}${merge ? " graph-merge" : ""}" cx="${graphX(row.lane)}" cy="32" r="4"/></svg>`;
}
function renderHistory() {
  const query = $<HTMLInputElement>("history-search").value.trim().toLowerCase();
  const commits = historyPage?.commits.filter((commit) => `${commit.oid} ${commit.author} ${commit.subject}`.toLowerCase().includes(query)) || [];
  const graph = layoutHistoryGraph(query ? [] : commits);
  const graphWidth = graphX(graph.lanes - 1) + 10;
  $("history-graph-note").textContent = query ? "Graph hidden while filtering. Clear the filter to see connections."
    : commits.length ? "Lines connect commits to parents · hollow dots: merges · dashed ends: parents not loaded" : "";
  $("history-list").innerHTML = commits.map((commit, index) => `<button class="history-entry ${commit.oid === historyDetails?.oid ? "selected" : ""}" style="min-width: ${query ? 0 : graphWidth + 180}px" data-commit="${commit.oid}" aria-pressed="${commit.oid === historyDetails?.oid}" title="${escape(`${commit.subject || "(no subject)"}\n${commit.oid} · ${commit.author} · ${commit.date}`)}">${query ? "" : historyGraphSvg(graph.rows[index], graphWidth, commit.parents.length > 1)}<span class="history-entry-text"><strong>${escape(commit.subject || "(no subject)")}</strong><small>${commit.oid.slice(0, 8)} · ${escape(commit.author)}${commit.parents.length > 1 ? ` · Merge (${commit.parents.length} parents)` : ""}</small><small>${escape(commit.date)}</small></span></button>`).join("") || '<p class="muted">No matching commits</p>';
  $("history-list").querySelectorAll<HTMLButtonElement>("[data-commit]").forEach((button) => {
    button.disabled = busy;
    button.onclick = () => void task(async () => {
      clearHistoryDetails();
      const response = await request({ type: "commitDetails", repo: historyRepo, oid: button.dataset.commit! });
      historyDetails = response.commitDetails;
      if (!historyDetails) return;
      $("history-message").textContent = historyDetails.message;
      const commit = historyPage?.commits.find((commit) => commit.oid === historyDetails!.oid);
      $("history-parent").textContent = `${historyDetails.oid}\n${historyDetails.parent ? `Compared with ${commit && commit.parents.length > 1 ? "first parent" : "parent"} ${historyDetails.parent}` : "Initial commit · compared with an empty tree"}`;
      $("history-files").innerHTML = historyDetails.files.map((file, index) => `<button data-commit-file="${index}" title="${escape(file.originalPath ? `${file.originalPath} → ${file.path}` : file.path)}"><span class="status">${escape(file.status)}</span> ${escape(file.originalPath ? `${file.originalPath} → ${file.path}` : file.path)}</button>`).join("") || '<p class="muted">No file changes relative to this parent.</p>';
      $("history-files").querySelectorAll<HTMLButtonElement>("[data-commit-file]").forEach((fileButton) => {
        fileButton.onclick = () => void task(async () => {
          const selected = historyDetails!.files[Number(fileButton.dataset.commitFile)];
          disposeHistoryDiff();
          $("history-diff-label").textContent = `Loading ${selected.path}…`;
          const response = await request({ type: "commitDiff", repo: historyRepo, oid: historyDetails!.oid, path: selected.path });
          const view = response.commitDiff;
          if (!view) return;
          $("history-diff-label").textContent = `${selected.path} · ${view.reason || "Parent → Commit · read-only"}`;
          $("history-files").querySelectorAll("button").forEach((item) => item.classList.toggle("selected", item === fileButton));
          if (!view.reason) {
            historyModels = [monaco.editor.createModel(view.before, language(selected.originalPath || view.path)), monaco.editor.createModel(view.after, language(view.path))];
            historyDiff = monaco.editor.createDiffEditor($("history-diff"), {
              ...editorOptions(), readOnly: true, domReadOnly: true, originalEditable: false,
              renderSideBySide: true, useInlineViewWhenSpaceIsLimited: true,
              ignoreTrimWhitespace: false, renderMarginRevertIcon: false,
            });
            historyDiff.setModel({ original: historyModels[0], modified: historyModels[1] });
          }
        });
      });
      $("history-status").textContent = `${historyPage?.commits.length} commits loaded · ${historyDetails.files.length} changed files`;
      renderHistory();
    });
  });
  $("history-more").hidden = historyPage?.nextOffset === undefined;
}
function loadHistory(more = false) {
  return task(async () => {
    if (!more) {
      historyPage = undefined;
      clearHistoryDetails();
      renderHistory();
    }
    $("history-status").textContent = "Loading history…";
    const response = await request({ type: "history", repo: historyRepo, tip: more ? historyPage?.tip : undefined, offset: more ? historyPage?.nextOffset : undefined });
    if (!response.history) return;
    historyPage = { ...response.history, commits: [...(more ? historyPage?.commits || [] : []), ...response.history.commits] };
    const repo = snapshot.repositories.find((repo) => repo.id === historyRepo);
    $("history-repo").textContent = `${repo?.name} · ${repo?.root} · HEAD ${historyPage.tip.slice(0, 8) || "unborn"}`;
    $("history-status").textContent = historyPage.tip ? `${historyPage.commits.length} commits loaded · HEAD at opening/refresh · read-only` : "No commits yet.";
    renderHistory();
  });
}
$("history").onclick = () => {
  if (!selectedCommitRepo() || busy) return;
  historyRepo = commitRepo;
  $<HTMLInputElement>("history-search").value = "";
  $("history-repo").textContent = selectedCommitRepo()!.name;
  $<HTMLDialogElement>("history-dialog").showModal();
  void loadHistory();
};
$("history-search").oninput = renderHistory;
$("history-more").onclick = () => void loadHistory(true);
$("refresh-history").onclick = () => void loadHistory();
$("close-history").onclick = () => $<HTMLDialogElement>("history-dialog").close();
$("history-dialog").addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
$("history-dialog").addEventListener("close", () => {
  historyPage = undefined;
  clearHistoryDetails();
});
async function openBranches(repo: string) {
  branchRepo = repo;
  branchList = undefined;
  $<HTMLInputElement>("branch-search").value = "";
  $("branch-status").textContent = "Loading branches…";
  $<HTMLDialogElement>("branches-dialog").showModal();
  await refreshBranches();
}
function refreshBranches() {
  return task(async () => {
    branchList = undefined;
    renderBranches();
    const response = await request({ type: "branches", repo: branchRepo });
    branchList = response.branches;
    $("branch-status").textContent = "Switching requires a clean repository and saved drafts. Remote branches create a local tracking branch.";
  });
}
function renderBranches() {
  const repo = snapshot.repositories.find((repo) => repo.id === branchRepo);
  $("branches-repo").textContent = repo ? `${repo.name} · ${repo.branch} · ${repo.root}` : "Repository unavailable";
  const query = $<HTMLInputElement>("branch-search").value.toLowerCase();
  $("branch-list").innerHTML = branchList ? (["local", "remote"] as const).map((kind) => {
    const branches = branchList!.branches.filter((branch) => branch.kind === kind && `${branch.name} ${branch.upstream || ""}`.toLowerCase().includes(query));
    return `<h3>${kind === "local" ? "Local branches" : "Remote branches (last fetched)"}</h3>${branches.length ? branches.map((branch) => {
      const localExists = branch.kind === "remote" && branchList!.branches.some((local) => local.kind === "local" && local.name === branch.localName);
      const reason = branch.current ? "Current branch" : branch.worktree ? `In worktree: ${branch.worktree}` : localExists ? `Select local branch: ${branch.localName}` : branch.kind === "remote" ? branch.localName ? `Create local: ${branch.localName}` : "Remote unavailable" : branch.upstream ? `Upstream: ${branch.upstream}` : "No upstream";
      return `<div class="branch-entry"><div><strong>${escape(branch.name)}</strong><small>${escape(reason)}</small></div><button data-switch-branch="${escape(branch.ref)}" ${busy || branch.current || branch.worktree || localExists || branch.kind === "remote" && !branch.localName ? "disabled" : ""}>${branch.kind === "remote" ? "Track &amp; switch" : "Switch"}</button></div>`;
    }).join("") : '<p class="muted">No matching branches</p>'}`;
  }).join("") : "";
  $("branch-list").querySelectorAll<HTMLButtonElement>("[data-switch-branch]").forEach((button) => {
    button.onclick = () => void task(async () => {
      if (Object.keys(persisted.drafts).some((id) => JSON.parse(id)[0] === branchRepo))
        throw new Error("Save or reload JiGit drafts in this repository before switching branches.");
      const previousBranch = snapshot.repositories.find((repo) => repo.id === branchRepo)?.branch;
      try {
        const response = await request({ type: "switchBranch", repo: branchRepo, ref: button.dataset.switchBranch!, token: branchList!.token });
        if (response.snapshot) applySnapshot(response.snapshot);
      } finally {
        // A post-checkout hook can fail after Git has already switched branches.
        if (file?.change.repo === branchRepo && snapshot.repositories.find((repo) => repo.id === branchRepo)?.branch !== previousBranch) clearFile();
      }
      commitRepo = branchRepo;
      $<HTMLSelectElement>("commit-repo").value = branchRepo;
      renderCommit();
      $<HTMLDialogElement>("branches-dialog").close();
      notify(`Switched branch in ${snapshot.repositories.find((repo) => repo.id === branchRepo)?.name}.`);
    });
  });
}
$("branches").onclick = () => { if (selectedCommitRepo()) void openBranches(commitRepo); };
$("branch-search").oninput = renderBranches;
$("refresh-branches").onclick = () => void refreshBranches();
$("close-branches").onclick = () => $<HTMLDialogElement>("branches-dialog").close();
$("branches-dialog").addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
$("refresh").onclick = () =>
  void task(async () => {
    const response = await request({ type: "refresh" });
    if (response.snapshot) applySnapshot(response.snapshot);
  });
$("dismiss").onclick = () => {
  $("notice").hidden = true;
};
$("reload").onclick = () => {
  if (!file || busy) return;
  if (dirty()) ($("discard-dialog") as HTMLDialogElement).showModal();
  else void selectFile(file.change, true);
};
$("cancel-discard").onclick = () =>
  ($("discard-dialog") as HTMLDialogElement).close();
$("confirm-discard").onclick = () => {
  ($("discard-dialog") as HTMLDialogElement).close();
  if (file) void selectFile(file.change, true);
};
$("open-file").onclick = () =>
  void task(async () => {
    if (file) await request({ type: "openFile", change: file.change });
  });
async function mutate(type: "save" | "stage" | "unstage" | "resolve") {
  if (!file) return;
  const current = file;
  await task(async () => {
    const response = await request({
      type,
      change: current.change,
      token: current.token,
      text: draftText(),
    });
    if (type === "save" || type === "resolve")
      delete persisted.drafts[current.change.id];
    if (response.snapshot) applySnapshot(response.snapshot);
    if (response.file) showFile(response.file);
    else {
      const group = type === "unstage" ? "working" : "staged";
      const next = snapshot.repositories
        .find((repo) => repo.id === current.change.repo)
        ?.changes.find(
          (change) =>
            change.path === current.change.path && change.group === group,
        );
      if (next) {
        const loaded = await request({ type: "load", change: next });
        if (loaded.file) showFile(loaded.file);
      } else {
        disposeEditors();
        file = undefined;
        $("file-view").hidden = true;
        $("empty").hidden = false;
        renderFiles();
      }
    }
    persist();
    notify(
      type === "save"
        ? "Saved to the working copy."
        : type === "resolve"
          ? "Conflict resolved. The result is staged for commit."
          : type === "stage"
            ? "File staged for commit."
            : "File unstaged. Working copy preserved.",
    );
  });
}
function showHunk(reveal = true) {
  const hunk = file?.hunks?.find((item) => item.id === $<HTMLSelectElement>("hunk-select").value);
  if (!hunk || !diff || !file || hasDraft(file.change) || $<HTMLInputElement>("whitespace").checked) return;
  [diff.getOriginalEditor(), diff.getModifiedEditor()].forEach((editor, index) => {
    const line = Math.max(1, index ? hunk.modifiedLine : hunk.originalLine);
    const count = index ? hunk.modifiedLines : hunk.originalLines;
    hunkHighlights[index].set([{ range: new monaco.Range(line, 1, line + Math.max(0, count - 1), 1), options: { isWholeLine: true, className: "selected-hunk" } }]);
    if (reveal) editor.revealLineInCenter(line);
  });
}
async function moveHunk() {
  if (!file || hasDraft(file.change) || $<HTMLInputElement>("whitespace").checked) return;
  const current = file;
  const hunk = $<HTMLSelectElement>("hunk-select").value;
  await task(async () => {
    const response = await request({ type: current.change.group === "staged" ? "unstageHunk" : "stageHunk", change: current.change, token: current.token, hunk });
    if (response.snapshot) applySnapshot(response.snapshot);
    const changes = snapshot.repositories.find((repo) => repo.id === current.change.repo)?.changes || [];
    const next = changes.find((change) => change.id === current.change.id) || changes.find((change) => change.path === current.change.path);
    if (next) {
      const loaded = await request({ type: "load", change: next });
      if (loaded.file) showFile(loaded.file);
    } else clearFile();
    persist();
    notify(current.change.group === "staged" ? "Block unstaged. Working copy preserved." : "Block staged for commit.");
  });
}
async function moveFiles(changes: Change[]) {
  await task(async () => {
    if (!changes.length) return;
    if (changes.some(hasDraft)) throw new Error("Save or reload selected files' drafts before moving them.");
    const repositories = snapshot.repositories.filter((repo) => changes.some((change) => change.repo === repo.id));
    const indexTokens = repositories.map((repo) => ({ repo: repo.id, token: repo.indexToken }));
    const files: { change: Change; token: string }[] = [];
    for (const change of changes) {
      const loaded = await request({ type: "load", change });
      if (!loaded.file) throw new Error("A selected file is no longer available.");
      files.push({ change, token: file?.change.id === change.id ? file.token : loaded.file.token });
    }
    const response = await request({ type: changes[0].group === "working" ? "stageSelection" : "unstageSelection", indexTokens, files });
    if (response.snapshot) applySnapshot(response.snapshot);
    commitRepo = changes[0].repo;
    ($("commit-repo") as HTMLSelectElement).value = commitRepo;
    renderCommit();
    // Refresh a clean open comparison after an index change; never replace a draft.
    if (file && repositories.some((repo) => repo.id === file!.change.repo) && !hasDraft(file.change)) {
      const moved = changes.some((change) => change.repo === file!.change.repo && change.path === file!.change.path);
      const group = moved ? changes[0].group === "working" ? "staged" : "working" : file.change.group;
      const next = snapshot.repositories.find((item) => item.id === file!.change.repo)?.changes.find((change) => change.path === file!.change.path && change.group === group);
      if (next) {
        const loaded = await request({ type: "load", change: next });
        if (loaded.file) showFile(loaded.file);
      } else clearFile();
    }
    persist();
    notify(`${changes.length} ${changes.length === 1 ? "file" : "files"} ${changes[0].group === "working" ? "staged" : "unstaged"}.`);
  });
}

let draftToDelete: string | undefined;
function renderDrafts() {
  $("draft-list").replaceChildren();
  for (const [id, draft] of Object.entries(persisted.drafts)) {
    const [repo, path] = JSON.parse(id) as string[];
    const row = document.createElement("div");
    row.className = "draft-entry";
    const label = document.createElement("p");
    label.textContent = `${path} · ${repo}`;
    row.append(label);
    const open = document.createElement("button");
    open.textContent = "Open copy in VS Code";
    open.onclick = () => void task(async () => { await request({ type: "openDraft", text: draft.text }); });
    row.append(open);
    const change = findChange(id);
    if (change) {
      const review = document.createElement("button");
      review.textContent = "Review";
      review.onclick = () => { ($("drafts-dialog") as HTMLDialogElement).close(); void selectFile(change); };
      row.append(review);
    }
    const discard = document.createElement("button");
    discard.textContent = "Discard…";
    discard.onclick = () => { draftToDelete = id; ($("delete-draft-dialog") as HTMLDialogElement).showModal(); };
    row.append(discard);
    $("draft-list").append(row);
  }
  if (!Object.keys(persisted.drafts).length) $("draft-list").textContent = "No unsaved drafts.";
}
$("drafts").onclick = () => { renderDrafts(); ($("drafts-dialog") as HTMLDialogElement).showModal(); };
$("close-drafts").onclick = () => ($("drafts-dialog") as HTMLDialogElement).close();
$("keep-draft").onclick = () => ($("delete-draft-dialog") as HTMLDialogElement).close();
$("delete-draft").onclick = () => {
  if (!draftToDelete) return;
  const id = draftToDelete;
  draftToDelete = undefined;
  delete persisted.drafts[id];
  if (file?.change.id === id) clearFile();
  persist();
  renderDrafts();
  renderFiles();
  syncControls();
  ($("delete-draft-dialog") as HTMLDialogElement).close();
};

async function moveFile(change: Change) {
  await task(async () => {
    if (hasDraft(change)) throw new Error("Save or reload this file's draft before moving it.");
    const current = file?.change.id === change.id ? file : (await request({ type: "load", change })).file;
    if (!current) return;
    const response = await request({
      type: change.group === "staged" ? "unstage" : "stage",
      change, token: current.token,
    });
    if (response.snapshot) applySnapshot(response.snapshot);
    commitRepo = change.repo;
    ($("commit-repo") as HTMLSelectElement).value = commitRepo;
    renderCommit();
    if (file?.change.repo === change.repo && file.change.path === change.path) {
      const next = snapshot.repositories.find((repo) => repo.id === change.repo)?.changes.find(
        (item) => item.path === change.path && item.group === (change.group === "staged" ? "working" : "staged"),
      );
      if (next) {
        const loaded = await request({ type: "load", change: next });
        if (loaded.file) showFile(loaded.file);
      } else clearFile();
    }
    persist();
    notify(change.group === "staged" ? "File unstaged. Working copy preserved." : "File staged for commit.");
  });
}
$("save").onclick = () => void mutate("save");
$("stage").onclick = () => void mutate("stage");
$("unstage").onclick = () => void mutate("unstage");
$("resolve").onclick = () => void mutate("resolve");
$("hunk-select").onchange = () => showHunk();
$("show-hunk").onclick = () => showHunk();
$("move-hunk").onclick = () => void moveHunk();
$("inline").onchange = () =>
  diff?.updateOptions({
    renderSideBySide: !($("inline") as HTMLInputElement).checked,
  });
$("context").onchange = () =>
  diff?.updateOptions({
    hideUnchangedRegions: {
      enabled: ($("context") as HTMLInputElement).checked,
    },
  });
$("whitespace").onchange = () => {
  diff?.updateOptions({
    ignoreTrimWhitespace: ($("whitespace") as HTMLInputElement).checked,
  });
  syncControls();
  showHunk(false);
};
function navigate(delta: number) {
  if (file?.change.group === "conflict") navigateConflict(delta);
  else diff?.goToDiff(delta > 0 ? "next" : "previous");
}
$("prev-change").onclick = () => navigate(-1);
$("next-change").onclick = () => navigate(1);
$("accept-yours").onclick = () => acceptBlock(currentConflict, "yours");
$("accept-both").onclick = () => acceptBlock(currentConflict, "both");
$("accept-theirs").onclick = () => acceptBlock(currentConflict, "theirs");
document.addEventListener("keydown", (event) => {
  if ($<HTMLDialogElement>("history-dialog").open) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (file?.editable && dirty()) void mutate("save");
  }
  if (event.altKey && ["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    navigate(event.key === "ArrowDown" ? 1 : -1);
  }
});
window.addEventListener("message", (event) => {
  const message = event.data as Response;
  if (message.type === "result") {
    // A reply queued by a disposed/reloaded webview cannot fulfill a new request.
    if (message.clientId !== clientId) return;
    const callback = pending.get(message.requestId);
    pending.delete(message.requestId);
    if (message.snapshot) applySnapshot(message.snapshot);
    if (message.error && message.committed && callback && "repo" in callback.data) {
      const repoId = callback.data.repo;
      const repo = snapshot.repositories.find((repo) => repo.id === repoId);
      if (repo) finishCommit(repo);
    }
    if (message.error) callback?.reject(new Error(message.error));
    else callback?.resolve(message);
  } else if (message.type === "snapshot") applySnapshot(message.snapshot);
  else if (message.type === "mode") setMode(message.conflicts);
  else if (message.type === "focus") {
    if (message.repo) {
      selectedRepo = message.repo;
      commitRepo = message.repo;
      ($("repo-filter") as HTMLSelectElement).value = selectedRepo;
      ($("commit-repo") as HTMLSelectElement).value = commitRepo;
      renderCommit();
      renderFiles();
    }
    if (message.change) {
      const change = snapshot.repositories
        .flatMap((repo) => repo.changes)
        .find((change) => change.id === message.change);
      if (change) void selectFile(change);
    }
  }
});
void request({ type: "restoreState" }).then((response) => {
  Object.assign(persisted, { drafts: {}, messages: {} }, response.state, localState);
  stateReady = true;
  // Migrate existing webview-only drafts even when their selected change is gone.
  vscode.setState(persisted);
  void request({ type: "persistState", state: persisted }).catch((error) => notify(`Could not back up drafts: ${error}`, true));
  selectedRepo = persisted.repo || "";
  commitRepo = selectedRepo;
  return request({ type: "refresh" });
})
  .then((response) => {
    if (response.snapshot) applySnapshot(response.snapshot);
    if (!file && persisted.selected) {
      const change = snapshot.repositories
        .flatMap((repo) => repo.changes)
        .find((change) => change.id === persisted.selected);
      if (change) void selectFile(change);
    }
  })
  .catch((error) => notify(String(error), true));
