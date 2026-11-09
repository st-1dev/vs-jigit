import * as vscode from "vscode";
import * as path from "node:path";
import { GitRepository } from "./git";
import { renderHtml } from "./html";
import { Change, PanelState, Request, Response, Snapshot } from "../shared/protocol";

interface GitRepo {
  rootUri: vscode.Uri;
  state: { onDidChange: vscode.Event<void> };
}
interface GitAPI {
  repositories: GitRepo[];
  git: { path: string };
  onDidOpenRepository: vscode.Event<GitRepo>;
  onDidCloseRepository: vscode.Event<GitRepo>;
}

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!vscode.workspace.isTrusted) return;
  const gitExtension = vscode.extensions.getExtension<{
    getAPI(version: number): GitAPI;
  }>("vscode.git");
  if (!gitExtension)
    throw new Error("Enable the built-in Git extension to use JiGit.");
  const git = (await gitExtension.activate()).getAPI(1);
  const controller = new Controller(context, git);
  context.subscriptions.push(controller);
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "vs-jigit.open",
      (target?: Change | string) => controller.open(target),
    ),
    vscode.commands.registerCommand("vs-jigit.conflicts", () =>
      controller.open(undefined, true),
    ),
    vscode.commands.registerCommand("vs-jigit.refresh", () =>
      controller.refresh(),
    ),
    vscode.window.registerTreeDataProvider(
      "vs-jigit.repositories",
      controller.tree,
    ),
  );
  await controller.refresh();
}

class RepositoriesTree implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  snapshot: Snapshot = { repositories: [] };
  update(snapshot: Snapshot) {
    this.snapshot = snapshot;
    this.changed.fire();
  }
  getTreeItem(item: vscode.TreeItem) {
    return item;
  }
  getChildren(): vscode.TreeItem[] {
    return this.snapshot.repositories.map((repo) => {
      const conflicts = repo.changes.filter(
        (change) => change.group === "conflict",
      ).length;
      const count = new Set(repo.changes.map((change) => change.path)).size;
      const item = new vscode.TreeItem(repo.name);
      item.description = `${repo.branch} · ${conflicts ? `${conflicts} conflicts` : `${count} files`}`;
      item.tooltip = repo.error || repo.root;
      item.iconPath = new vscode.ThemeIcon(conflicts ? "warning" : "repo");
      item.command = {
        command: "vs-jigit.open",
        title: "Open changes",
        arguments: [repo.id],
      };
      return item;
    });
  }
  dispose() {
    this.changed.dispose();
  }
}

class Controller implements vscode.Disposable {
  readonly tree = new RepositoriesTree();
  private panel?: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly watches = new Map<GitRepo, vscode.Disposable>();
  private repositories = new Map<string, GitRepository>();
  private snapshot: Snapshot = { repositories: [] };
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<unknown> = Promise.resolve();
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly git: GitAPI,
  ) {
    this.watch();
    this.subscriptions.push(
      git.onDidOpenRepository(() => {
        this.watch();
        this.schedule();
      }),
    );
    this.subscriptions.push(
      git.onDidCloseRepository(() => {
        this.watch();
        this.schedule();
      }),
    );
    this.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
    );
    this.subscriptions.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.schedule();
      }),
    );
  }

  private watch() {
    for (const [repo, subscription] of this.watches) {
      if (!this.git.repositories.includes(repo)) {
        subscription.dispose();
        this.watches.delete(repo);
      }
    }
    this.repositories = new Map(
      this.git.repositories
        .filter((repo) => repo.rootUri.scheme === "file")
        .map((repo) => {
          if (!this.watches.has(repo))
            this.watches.set(
              repo,
              repo.state.onDidChange(() => this.schedule()),
            );
          return [
            repo.rootUri.fsPath,
            new GitRepository(repo.rootUri.fsPath, this.git.git.path),
          ];
        }),
    );
  }

  private schedule() {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.refresh();
    }, 300);
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.refreshing) {
      // A mutation may finish while an older status read is in flight. Its
      // caller must wait for the repeated read before using the snapshot.
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = this.readSnapshots().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async readSnapshots(): Promise<void> {
    do {
      this.refreshAgain = false;
      const repositories = await Promise.all(
        [...this.repositories.values()].map(async (repo) => {
          try {
            return await repo.snapshot();
          } catch (error) {
            return {
              id: repo.root,
              root: repo.root,
              name: repo.root.split(/[\\/]/).pop()!,
              branch: "Unavailable",
              changes: [],
              indexToken: "",
              error: String(error),
            };
          }
        }),
      );
      this.snapshot = { repositories };
      this.tree.update(this.snapshot);
      this.post({ type: "snapshot", snapshot: this.snapshot });
    } while (this.refreshAgain && !this.disposed);
  }

  async open(target?: Change | string, conflicts = false) {
    if (!this.panel) {
      const assets = vscode.Uri.joinPath(
        this.context.extensionUri,
        "dist",
        "web",
      );
      this.panel = vscode.window.createWebviewPanel(
        "vs-jigit",
        "JiGit",
        vscode.ViewColumn.Active,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [assets],
        },
      );
      const panel = this.panel;
      panel.iconPath = vscode.Uri.joinPath(
        this.context.extensionUri,
        "media",
        "jigit.svg",
      );
      const url = (name: string) =>
        panel.webview
          .asWebviewUri(vscode.Uri.joinPath(assets, name))
          .toString();
      panel.webview.html = renderHtml(
        panel.webview.cspSource,
        url("app.js"),
        url("app.css"),
        url("editor.worker.js"),
      );
      const receive = panel.webview.onDidReceiveMessage((message) => {
        // Mutations and loads share a queue, so a late read cannot overtake a save.
        this.queue = this.queue
          .then(() => this.handle(message))
          .catch((error) => {
            void vscode.window.showErrorMessage(String(error));
          });
      });
      panel.onDidDispose(() => {
        receive.dispose();
        if (this.panel === panel) this.panel = undefined;
      });
    }
    this.panel.reveal();
    // Initial navigation is also sent in response to the webview's first refresh.
    this.navigation = {
      type: "focus",
      ...(typeof target === "string"
        ? { repo: target }
        : target
          ? { repo: target.repo, change: target.id }
          : {}),
    };
    this.conflicts = conflicts;
    this.navigationPending = true;
    this.post({ type: "mode", conflicts });
    this.post(this.navigation);
  }

  private navigation: Response = { type: "focus" };
  private conflicts = false;
  private navigationPending = false;
  private post(message: Response) {
    if (!this.disposed) void this.panel?.webview.postMessage(message);
  }

  private async handle(raw: unknown): Promise<void> {
    if (!raw || typeof raw !== "object") return;
    const request = raw as Request & { requestId: number; clientId?: string };
    if (!Number.isSafeInteger(request.requestId)) return;
    const result: Extract<Response, { type: "result" }> = {
      type: "result",
      requestId: request.requestId,
      clientId: request.clientId,
    };
    try {
      if (!vscode.workspace.isTrusted)
        throw new Error("A trusted workspace is required.");
      if (request.type === "restoreState") {
        result.state = this.context.workspaceState.get<PanelState>("vs-jigit.panelState");
      } else if (request.type === "persistState") {
        await this.context.workspaceState.update("vs-jigit.panelState", request.state);
      } else if (request.type === "openDraft") {
        if (typeof request.text !== "string") throw new Error("Invalid draft content.");
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: request.text }));
      } else if (request.type === "refresh") {
        await this.refresh();
        result.snapshot = this.snapshot;
        if (this.navigationPending) {
          this.post({ type: "mode", conflicts: this.conflicts });
          this.post(this.navigation);
          this.navigationPending = false;
        }
      } else if (request.type === "revertBatch" || request.type === "stageSelection" || request.type === "unstageSelection") {
        if (!Array.isArray(request.files) || !request.files.length)
          throw new Error("Select at least one file.");
        const batches = new Map<GitRepository, typeof request.files>();
        const drafts = this.context.workspaceState.get<PanelState>("vs-jigit.panelState")?.drafts || {};
        for (const item of request.files) {
          const repo = this.repositories.get(item.change.repo);
          if (!repo) throw new Error("The repository is no longer open in this workspace.");
          const fresh = await repo.load(item.change);
          const paths = [fresh.change.path, fresh.change.originalPath].filter((name): name is string => !!name);
          if (vscode.workspace.textDocuments.some((doc) => doc.isDirty && paths.some((name) => repo.absolute(name) === doc.uri.fsPath)))
            throw new Error("This file has unsaved changes in a VS Code editor. Save it there before applying changes here.");
          if (Object.keys(drafts).some((id) => {
            const [root, name] = JSON.parse(id);
            return root === repo.root && paths.includes(name);
          })) throw new Error(request.type === "revertBatch"
            ? "Save or reload this file's JiGit draft before reverting it."
            : "Save or reload selected files' JiGit drafts before moving them.");
          const files = batches.get(repo) || [];
          files.push(item);
          batches.set(repo, files);
        }
        const plans: (() => Promise<void>)[] = [];
        for (const [repo, files] of batches) {
          if (request.type === "revertBatch") plans.push(await repo.prepareRevertBatch(files));
          else {
            const token = request.indexTokens?.find((item) => item.repo === repo.root)?.token;
            if (!token) throw new Error("Refresh before moving files.");
            plans.push(await repo.prepareMoveBatch(request.type === "stageSelection" ? "stageBatch" : "unstageBatch", files, token));
          }
        }
        let completed = 0;
        try {
          for (const plan of plans) { await plan(); completed++; }
        } catch (error) {
          throw new Error(`${completed} repositories completed. ${error instanceof Error ? error.message : String(error)}`);
        }
        await this.refresh();
        result.snapshot = this.snapshot;
      } else {
        const id =
          "change" in request
            ? request.change?.repo
            : "repo" in request
              ? request.repo
              : undefined;
        const repo =
          typeof id === "string" ? this.repositories.get(id) : undefined;
        if (!repo)
          throw new Error(
            "The repository is no longer open in this workspace.",
          );
        if (request.type === "load")
          result.file = await repo.load(request.change);
        else if (request.type === "openFile") {
          const file = await repo.load(request.change);
          await vscode.window.showTextDocument(
            vscode.Uri.file(repo.absolute(file.change.path)),
          );
        } else if (request.type === "branches") {
          result.branches = await repo.branches();
        } else if (request.type === "history") {
          result.history = await repo.history(request.tip, request.offset);
        } else if (request.type === "commitDetails") {
          result.commitDetails = await repo.commitDetails(request.oid);
        } else if (request.type === "commitDiff") {
          result.commitDiff = await repo.commitDiff(request.oid, request.path);
        } else if (request.type === "switchBranch") {
          if (vscode.workspace.textDocuments.some((doc) => doc.isDirty && repoContains(repo.root, doc.uri.fsPath)))
            throw new Error("Save unsaved changes in VS Code editors before switching branches.");
          const drafts = this.context.workspaceState.get<PanelState>("vs-jigit.panelState")?.drafts || {};
          if (Object.keys(drafts).some((id) => JSON.parse(id)[0] === repo.root))
            throw new Error("Save or reload JiGit drafts in this repository before switching branches.");
          await repo.switchBranch(request.ref, request.token);
          await this.refresh();
          result.snapshot = this.snapshot;
        } else if (request.type === "commit" || request.type === "commitPush") {
          if (
            typeof request.message !== "string" ||
            request.message.length > 65536
          )
            throw new Error("Invalid commit message.");
          await repo.commit(request.message, request.indexToken);
          result.committed = true;
          if (request.type === "commitPush") {
            try {
              await repo.push((await repo.snapshot()).indexToken);
            } catch (error) {
              throw new Error(`Commit succeeded. Push failed: ${error instanceof Error ? error.message : String(error)} Use Push to retry without creating another commit.`);
            }
          }
          await this.refresh();
          result.snapshot = this.snapshot;
        } else if (request.type === "pull" || request.type === "push" || request.type === "fetch") {
          if (request.type === "pull" && vscode.workspace.textDocuments.some(
            (doc) => doc.isDirty && repoContains(repo.root, doc.uri.fsPath),
          ))
            throw new Error("Save unsaved changes in VS Code editors before pulling.");
          await repo[request.type](request.indexToken);
          await this.refresh();
          result.snapshot = this.snapshot;
        } else if (request.type === "stageBatch" || request.type === "unstageBatch") {
          if (!Array.isArray(request.files) || !request.files.length)
            throw new Error("Select at least one file.");
          const snapshot = await repo.snapshot();
          for (const item of request.files) {
            const fresh = snapshot.changes.find((change) => change.id === item.change.id);
            if (!fresh) throw new Error("A selected change is no longer available. Refresh the file list.");
            const paths = [fresh.path, fresh.originalPath].filter((path): path is string => !!path).map((path) => repo.absolute(path));
            if (vscode.workspace.textDocuments.some((doc) => doc.isDirty && paths.includes(doc.uri.fsPath)))
              throw new Error("A selected file has unsaved changes in a VS Code editor. Save it there before moving files.");
          }
          await repo.moveBatch(request.type, request.files, request.indexToken);
          await this.refresh();
          result.snapshot = this.snapshot;
        } else if (
          request.type === "save" ||
          request.type === "resolve" ||
          request.type === "stage" ||
          request.type === "stageHunk" ||
          request.type === "unstageHunk" ||
          request.type === "revert" ||
          request.type === "unstage"
        ) {
          const fresh = await repo.load(request.change);
          const paths = [fresh.change.path, fresh.change.originalPath].filter((name): name is string => !!name);
          const absolutes = paths.map((name) => repo.absolute(name));
          if (
            vscode.workspace.textDocuments.some(
              (doc) => absolutes.includes(doc.uri.fsPath) && doc.isDirty,
            )
          ) {
            throw new Error(
              "This file has unsaved changes in a VS Code editor. Save it there before applying changes here.",
            );
          }
          if (request.type === "revert") {
            const drafts = this.context.workspaceState.get<PanelState>("vs-jigit.panelState")?.drafts || {};
            if (Object.keys(drafts).some((id) => {
              const [root, name] = JSON.parse(id);
              return root === repo.root && paths.includes(name);
            })) throw new Error("Save or reload this file's JiGit draft before reverting it.");
            await repo.revert(request.change, request.token);
          } else if (request.type === "save" || request.type === "resolve") {
            if (typeof request.text !== "string")
              throw new Error("Invalid file content.");
            await repo.save(
              request.change,
              request.token,
              request.text,
              request.type === "resolve",
            );
            if (request.type === "save") {
              // Saving can restore the index version and remove the working change.
              const updated = await repo.snapshot();
              const remaining = updated.changes.find(
                (change) => change.id === fresh.change.id,
              );
              if (remaining) result.file = await repo.load(remaining);
            }
          } else if (request.type === "stageHunk" || request.type === "unstageHunk")
            await repo.moveHunk(request.type, request.change, request.token, request.hunk);
          else if (request.type === "stage")
            await repo.stage(request.change, request.token);
          else await repo.unstage(request.change, request.token);
          await this.refresh();
          result.snapshot = this.snapshot;
        } else throw new Error("Unknown JiGit action.");
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      // A network failure may follow a successful commit or fetch. Publish reality.
      if (["commit", "commitPush", "push", "pull", "fetch", "switchBranch", "stageBatch", "unstageBatch", "revert", "revertBatch", "stageSelection", "unstageSelection"].includes(request.type)) {
        await this.refresh();
        result.snapshot = this.snapshot;
      }
    }
    this.post(result);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.panel?.dispose();
    this.tree.dispose();
    for (const watch of this.watches.values()) watch.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }
}

function repoContains(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}
