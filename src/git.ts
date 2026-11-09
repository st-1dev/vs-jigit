import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { Branch, BranchList, Change, CommitDetails, CommitDiff, CommitSummary, FileView, HistoryPage, Repository } from "../shared/protocol";
import { hasConflictMarkers } from "../shared/conflicts";

const LIMIT = 2 * 1024 * 1024;
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export function parseStatus(repo: string, raw: string): Change[] {
  const records = raw.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2),
      file = record.slice(3);
    const originalPath = /[RC]/.test(status) ? records[++i] : undefined;
    const add = (group: Change["group"], code: string) =>
      changes.push({
        id: JSON.stringify([repo, file, group]),
        repo,
        path: file,
        group,
        status: code,
        ...(originalPath ? { originalPath } : {}),
      });
    if (conflictCodes.has(status)) add("conflict", status);
    else if (status === "??") add("working", "?");
    else {
      if (status[0] !== " " && status[0] !== "!") add("staged", status[0]);
      if (status[1] !== " " && status[1] !== "!") add("working", status[1]);
    }
  }
  return changes;
}

interface Entry {
  mode: string;
  oid: string;
  stage: number;
  path: string;
}
function parseEntries(raw: string): Entry[] {
  return raw
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode, oid, stage] = record.slice(0, tab).split(" ");
      return { mode, oid, stage: Number(stage), path: record.slice(tab + 1) };
    });
}

export class GitRepository {
  constructor(
    readonly root: string,
    private readonly executable = "git",
  ) {}

  async run(args: string[], timeout = 30_000, input?: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.executable,
        ["-C", this.root, ...args],
        {
          encoding: "buffer",
          maxBuffer: 32 * 1024 * 1024,
          timeout,
          windowsHide: true,
          env: {
            ...process.env,
            GIT_LITERAL_PATHSPECS: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
        },
        (error, stdout, stderr) => {
          if (error)
            reject(new Error(
              [stderr.toString("utf8").trim(), stdout.toString("utf8").trim()]
                .filter(Boolean).join("\n") || error.message,
            ));
          else resolve(stdout);
        },
      );
      // NUL-delimited pathspecs avoid OS argument limits and preserve unusual names.
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    });
  }

  private async head(): Promise<string> {
    // An unborn branch is a normal state. Other failures remain visible via status.
    try {
      return (await this.run(["rev-parse", "--verify", "HEAD"]))
        .toString()
        .trim();
    } catch {
      return "";
    }
  }

  async snapshot(): Promise<Repository> {
    const [status, index, head] = await Promise.all([
      this.run(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.run(["ls-files", "--stage", "-z"]),
      this.head(),
    ]);
    let branch: string;
    try {
      branch = (await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"]))
        .toString()
        .trim();
    } catch {
      branch = `${head.slice(0, 8)} (detached)`;
    }
    let upstream: string | undefined, ahead: number | undefined, behind: number | undefined, syncError: string | undefined;
    if (head) {
      // for-each-ref also identifies configured upstreams whose remote ref was deleted.
      try {
        upstream = (await this.run(["for-each-ref", "--format=%(upstream:short)", "--", `refs/heads/${branch}`])).toString().trim() || undefined;
        if (upstream) {
          const counts = (await this.run(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])).toString().trim().split(/\s+/).map(Number);
          [ahead, behind] = counts;
        }
      } catch {
        syncError = "Upstream unavailable; fetch or check its configuration.";
      }
    }
    return {
      id: this.root,
      root: this.root,
      name: path.basename(this.root),
      branch,
      upstream, ahead, behind, syncError,
      changes: parseStatus(this.root, status.toString("utf8")),
      indexToken: hash(
        Buffer.concat([index, Buffer.from(head + "\0" + branch)]),
      ),
    };
  }

  absolute(file: string): string {
    const absolute = path.resolve(this.root, file);
    const relative = path.relative(this.root, absolute);
    if (
      !file ||
      path.isAbsolute(file) ||
      !relative ||
      relative.startsWith(".." + path.sep) ||
      relative === ".." ||
      relative.split(path.sep).includes(".git")
    ) {
      throw new Error("Invalid repository path.");
    }
    return absolute;
  }

  private async working(
    file: string,
  ): Promise<{ buffer: Buffer; fingerprint: string; reason?: string }> {
    const absolute = this.absolute(file);
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile())
        return {
          buffer: Buffer.alloc(0),
          fingerprint: `${stat.mode}:${stat.mtimeMs}`,
          reason:
            "Symlinks and submodules are available through Open file; text editing is disabled.",
        };
      const [actual, root] = await Promise.all([
        fs.realpath(absolute),
        fs.realpath(this.root),
      ]);
      if (path.relative(root, actual) !== path.relative(this.root, absolute))
        throw new Error(
          "Files reached through a symlink cannot be edited here.",
        );
      if (stat.size > LIMIT)
        return {
          buffer: Buffer.alloc(0),
          fingerprint: `${stat.size}:${stat.mtimeMs}`,
          reason:
            "This file is larger than the 2 MB text editor limit. Use Open file.",
        };
      const buffer = await fs.readFile(absolute);
      return { buffer, fingerprint: hash(buffer) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { buffer: Buffer.alloc(0), fingerprint: "missing" };
      throw error;
    }
  }

  async load(requested: Change): Promise<FileView> {
    const snapshot = await this.snapshot();
    const change = snapshot.changes.find((item) => item.id === requested.id);
    if (!change)
      throw new Error(
        "This change is no longer available. Refresh the file list.",
      );
    const [entryBytes, work] = await Promise.all([
      this.run(["ls-files", "--stage", "-z", "--", change.path]),
      this.working(change.path),
    ]);
    const entries = parseEntries(entryBytes.toString("utf8"));
    let reason = work.reason;
    const text = async (entry?: Entry): Promise<string> => {
      if (!entry) return "";
      if (entry.mode !== "100644" && entry.mode !== "100755") {
        reason =
          "This change is not a regular text file. Use Open file or the built-in Git tools.";
        return "";
      }
      const size = Number(
        (await this.run(["cat-file", "-s", entry.oid])).toString(),
      );
      if (size > LIMIT) {
        reason =
          "This file is larger than the 2 MB text editor limit. Use Open file.";
        return "";
      }
      return decode(await this.run(["cat-file", "blob", entry.oid]));
    };
    const decode = (buffer: Buffer): string => {
      if (buffer.includes(0)) {
        reason = "Binary files cannot be edited in the text comparison.";
        return "";
      }
      try {
        return new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(buffer);
      } catch {
        reason =
          "This file is not UTF-8. Use Open file to preserve its encoding.";
        return "";
      }
    };
    let before = "",
      after = "",
      yours: string | undefined,
      theirs: string | undefined,
      base: string | undefined;
    if (change.group === "conflict") {
      [base, yours, theirs] = await Promise.all([
        text(entries.find((e) => e.stage === 1)),
        text(entries.find((e) => e.stage === 2)),
        text(entries.find((e) => e.stage === 3)),
      ]);
      after = decode(work.buffer);
      if (
        !entries.some((e) => e.stage === 2) ||
        !entries.some((e) => e.stage === 3)
      ) {
        reason =
          "This conflict includes a deletion. Resolve the file/deletion choice using the built-in Git tools.";
      }
      if (work.fingerprint === "missing")
        reason =
          "The working file is missing. Restore it before resolving the conflict.";
    } else if (change.group === "staged") {
      const head = await this.head();
      if (head) {
        const raw = (
          await this.run([
            "ls-tree",
            "-z",
            head,
            "--",
            change.originalPath || change.path,
          ])
        ).toString("utf8");
        if (raw) {
          const [mode, , oid] = raw.slice(0, raw.indexOf("\t")).split(" ");
          before = await text({ mode, oid, stage: 0, path: change.path });
        }
      }
      after = await text(entries.find((e) => e.stage === 0));
    } else {
      before = await text(entries.find((e) => e.stage === 0));
      after = decode(work.buffer);
    }
    return {
      change,
      before,
      after,
      yours,
      theirs,
      base,
      reason,
      hunks: !reason ? (await this.hunkPatches(change)).map(({ patch, ...hunk }) => hunk) : [],
      editable:
        !reason && change.group !== "staged" && work.fingerprint !== "missing",
      token: hash(
        snapshot.indexToken +
          "\0" +
          entryBytes.toString() +
          "\0" +
          work.fingerprint,
      ),
    };
  }

  private async verify(change: Change, token: string): Promise<FileView> {
    const fresh = await this.load(change);
    if (fresh.token !== token)
      throw new Error(
        "The file or Git index changed outside JiGit. Your draft is kept. Reload the file before applying it.",
      );
    return fresh;
  }

  private async hunkPatches(change: Change) {
    // Content-only changes keep path and mode operations out of partial staging.
    if (change.group === "conflict" || change.status !== "M" || change.originalPath) return [];
    const attributes = (await this.run(["check-attr", "-z", "filter", "working-tree-encoding", "--", change.path])).toString().split("\0");
    // Filters/encoding conversions can make Git's patch differ from the visible text.
    if (attributes.some((value, index) => index % 3 === 2 && value !== "unspecified" && value !== "unset")) return [];
    const raw = (await this.run([
      "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",
      "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3",
      "--inter-hunk-context=0", "--diff-algorithm=myers", "--no-indent-heuristic",
      "--output-indicator-new=+", "--output-indicator-old=-", "--output-indicator-context= ",
      ...(change.group === "staged" ? ["--cached"] : []), "--", change.path,
    ])).toString("utf8");
    const matches = [...raw.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[^\n]*\n/gm)];
    if (!matches.length) return [];
    const prefix = raw.slice(0, matches[0].index);
    if (/^(old mode|new mode|new file mode|deleted file mode) /m.test(prefix)) return [];
    return matches.map((match, index) => {
      const patch = prefix + raw.slice(match.index, matches[index + 1]?.index ?? raw.length);
      return { id: hash(patch), header: match[0].trim(), originalLine: Number(match[1]), originalLines: Number(match[2] ?? 1), modifiedLine: Number(match[3]), modifiedLines: Number(match[4] ?? 1), patch };
    });
  }

  async moveHunk(type: "stageHunk" | "unstageHunk", change: Change, token: string, id: string): Promise<void> {
    const fresh = await this.verify(change, token);
    if (fresh.reason || fresh.change.group !== (type === "stageHunk" ? "working" : "staged"))
      throw new Error("Select a text block in the matching Local or Staged changes group.");
    const hunk = (await this.hunkPatches(fresh.change)).find((item) => item.id === id);
    if (!hunk) throw new Error("This block is no longer available. Reload the file.");
    await this.verify(change, token);
    await this.run([
      "apply", "--cached", "--whitespace=nowarn",
      ...(type === "unstageHunk" ? ["--reverse"] : []), "-",
    ], 30_000, hunk.patch);
  }

  async save(
    change: Change,
    token: string,
    value: string,
    resolve: boolean,
  ): Promise<void> {
    if (Buffer.byteLength(value, "utf8") > LIMIT)
      throw new Error("The edited result exceeds the 2 MB text editor limit.");
    const fresh = await this.verify(change, token);
    if (!fresh.editable)
      throw new Error(fresh.reason || "This comparison is read-only.");
    if (
      resolve &&
      (fresh.change.group !== "conflict" || hasConflictMarkers(value))
    ) {
      throw new Error(
        "Remove every conflict marker before marking the file resolved.",
      );
    }
    // Monaco consumes a UTF-8 BOM; keep the on-disk encoding when saving.
    if (fresh.after.startsWith("\uFEFF") && !value.startsWith("\uFEFF"))
      value = "\uFEFF" + value;
    const absolute = this.absolute(fresh.change.path);
    const stat = await fs.stat(absolute);
    const temp = path.join(
      path.dirname(absolute),
      `.vs-jigit-${randomBytes(12).toString("hex")}.tmp`,
    );
    try {
      await fs.writeFile(temp, value, {
        encoding: "utf8",
        mode: stat.mode,
        flag: "wx",
      });
      await fs.chmod(temp, stat.mode & 0o777);
      await this.verify(change, token);
      await fs.rename(temp, absolute);
    } finally {
      await fs.rm(temp, { force: true });
    }
    if (resolve) await this.run(["add", "--", fresh.change.path]);
  }

  async stage(change: Change, token: string): Promise<void> {
    const fresh = await this.verify(change, token);
    if (fresh.change.group === "conflict")
      throw new Error("Use Mark resolved after reviewing the merge result.");
    if (fresh.change.group !== "working")
      throw new Error("Only working changes can be staged.");
    await this.run(["add", "--", fresh.change.path]);
  }

  async unstage(change: Change, token: string): Promise<void> {
    const fresh = await this.verify(change, token);
    if (fresh.change.group !== "staged")
      throw new Error("This change is not staged.");
    const paths = [
      ...new Set(
        [fresh.change.path, fresh.change.originalPath].filter(
          (item): item is string => Boolean(item),
        ),
      ),
    ];
    if (await this.head())
      await this.run(["reset", "-q", "HEAD", "--", ...paths]);
    else await this.run(["rm", "--cached", "-q", "-f", "--", ...paths]);
  }

  async revert(change: Change, token: string): Promise<void> {
    await (await this.prepareRevertBatch([{ change, token }]))();
  }

  // Validate every target before changing any file. The returned operation can
  // be prepared for several repositories before executing the first one.
  async prepareRevertBatch(files: { change: Change; token: string }[]): Promise<() => Promise<void>> {
    if (!files.length) throw new Error("Select at least one file.");
    const plans: { change: Change; token: string; apply: () => Promise<void> }[] = [];
    const paths = new Set<string>();
    for (const item of files) {
      if (item.change.repo !== this.root) throw new Error("The selected file belongs to another repository.");
      const plan = await this.prepareRevert(item.change, item.token);
      for (const name of plan.paths) {
        if (paths.has(name)) throw new Error("Overlapping revert targets. Select each file once.");
        paths.add(name);
      }
      plans.push({ ...item, apply: plan.apply });
    }
    return async () => {
      // Check the entire batch again before the first index mutation invalidates
      // its tokens. Each plan retains the original HEAD and path checks.
      for (const item of plans) await this.prepareRevert(item.change, item.token);
      let completed = 0;
      try {
        for (const plan of plans) { await plan.apply(); completed++; }
      } catch (error) {
        throw new Error(`${completed} of ${plans.length} files reverted. ${error instanceof Error ? error.message : String(error)}`);
      }
    };
  }

  private async prepareRevert(change: Change, token: string): Promise<{ paths: string[]; apply: () => Promise<void> }> {
    const fresh = await this.verify(change, token);
    change = fresh.change;
    if (change.group === "conflict")
      throw new Error("Resolve conflicts with the merge editor or built-in Git tools.");
    // Keep destructive operations within ordinary files, including deleted files.
    // In particular, never recurse into a submodule or follow a symlink parent.
    const paths = [change.path];
    if (change.group === "staged" && change.status === "R" && change.originalPath)
      paths.push(change.originalPath);
    const checkPaths = async () => {
      const root = await fs.realpath(this.root);
      for (const name of paths) {
        const absolute = this.absolute(name);
        let parent = path.dirname(absolute);
        while (true) {
          try {
            if (await fs.realpath(parent) !== path.resolve(root, path.relative(this.root, parent)))
              throw new Error("Cannot revert files reached through a symlink.");
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            parent = path.dirname(parent);
          }
        }
        try {
          const stat = await fs.lstat(absolute);
          if (!stat.isFile()) throw new Error("Revert supports regular files only. Use the built-in Git tools for symlinks and submodules.");
          if (name !== change.path) throw new Error("The original rename path is occupied. Move it before reverting the rename.");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    };
    await checkPaths();
    const head = await this.head();
    const entryBytes = await this.run(["ls-files", "--stage", "-z", "--", ...paths]);
    const entries = parseEntries(entryBytes.toString());
    const fingerprints = await Promise.all(paths.map(async (name) => (await this.working(name)).fingerprint));
    const tree = change.group === "staged" && head
      ? (await this.run(["ls-tree", "-z", head, "--", ...paths])).toString().split("\0").filter(Boolean)
      : [];
    if (entries.some((entry) => !/^100(644|755)$/.test(entry.mode)) || tree.some((entry) => !/^100(644|755) /.test(entry)))
      throw new Error("Revert supports regular files only. Use the built-in Git tools for symlinks and submodules.");
    await this.verify(change, token);
    return {
      paths,
      apply: async () => {
        // Earlier plans may change the index. Compare this target's entries and
        // working bytes directly so an external edit during the batch is kept.
        await checkPaths();
        if (await this.head() !== head ||
            !entryBytes.equals(await this.run(["ls-files", "--stage", "-z", "--", ...paths])) ||
            (await Promise.all(paths.map(async (name) => (await this.working(name)).fingerprint))).some((value, i) => value !== fingerprints[i]))
          throw new Error("The file or Git index changed outside JiGit. Reload the file before reverting it.");
        if (change.group === "working") {
          if (entries.length) await this.run(["restore", "--worktree", "--", change.path]);
          else await fs.unlink(this.absolute(change.path));
        } else if (head && tree.length) {
          // Including the rename destination removes it if it does not exist in HEAD.
          await this.run(["restore", `--source=${head}`, "--staged", "--worktree", "--", ...paths]);
        } else {
          // Added files (also on unborn branches) have no HEAD version to restore.
          await this.run(["rm", "-f", "--", change.path]);
        }
      },
    };
  }

  async moveBatch(type: "stageBatch" | "unstageBatch", files: { change: Change; token: string }[], indexToken: string): Promise<void> {
    await (await this.prepareMoveBatch(type, files, indexToken))();
  }

  async prepareMoveBatch(type: "stageBatch" | "unstageBatch", files: { change: Change; token: string }[], indexToken: string): Promise<() => Promise<void>> {
    if (!files.length) throw new Error("Select at least one file.");
    const verifyIndex = async () => {
      if ((await this.snapshot()).indexToken !== indexToken)
        throw new Error("The staged files or branch changed. Refresh before moving files.");
    };
    await verifyIndex();
    const paths = new Set<string>();
    for (const item of files) {
      if (item.change.repo !== this.root) throw new Error("Select files from one repository.");
      const fresh = await this.verify(item.change, item.token);
      if (fresh.change.group !== (type === "stageBatch" ? "working" : "staged"))
        throw new Error("Only local or staged changes can be moved to the opposite group.");
      paths.add(fresh.change.path);
      if (type === "unstageBatch" && fresh.change.originalPath) paths.add(fresh.change.originalPath);
    }
    await verifyIndex();
    const args = type === "stageBatch" ? ["add"] : await this.head()
      ? ["reset", "-q", "HEAD"] : ["rm", "--cached", "-q", "-f"];
    return async () => {
      await verifyIndex();
      for (const item of files) await this.verify(item.change, item.token);
      await this.run([...args, "--pathspec-from-file=-", "--pathspec-file-nul"], 30_000, [...paths].join("\0") + "\0");
    };
  }

  private async verifyCommit(oid: string): Promise<void> {
    if (typeof oid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
      throw new Error("Invalid commit ID. Refresh history.");
    if ((await this.run(["cat-file", "-t", oid])).toString().trim() !== "commit")
      throw new Error("This object is not a commit. Refresh history.");
  }

  async history(tip?: string, offset = 0): Promise<HistoryPage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000)
      throw new Error("Invalid history offset.");
    if (tip !== undefined) await this.verifyCommit(tip);
    else tip = await this.head();
    if (!tip) return { tip: "", commits: [] };
    const raw = (await this.run(["log", "--topo-order", "--no-show-signature", "--no-notes", "--encoding=UTF-8", "-z",
      "--format=%H%x00%P%x00%an%x00%aI%x00%s", "--max-count=51", `--skip=${offset}`, tip, "--"])).toString("utf8");
    const fields = raw.split("\0");
    const commits: CommitSummary[] = [];
    for (let i = 0; i + 4 < fields.length; i += 5) {
      const [oid, parents, author, date, subject] = fields.slice(i, i + 5);
      commits.push({ oid, parents: parents ? parents.split(" ") : [], author, date, subject });
    }
    return { tip, commits: commits.slice(0, 50), nextOffset: commits.length > 50 ? offset + 50 : undefined };
  }

  async commitDetails(oid: string): Promise<CommitDetails> {
    await this.verifyCommit(oid);
    const raw = (await this.run(["show", "-s", "--no-show-signature", "--no-notes", "--encoding=UTF-8", "--format=%P%x00%B", oid, "--"])).toString("utf8");
    const separator = raw.indexOf("\0");
    const parent = raw.slice(0, separator).split(" ")[0] || undefined;
    const records = (await this.run(["diff-tree", "--no-commit-id", "--name-status", "--no-ext-diff", "--no-textconv", "--no-relative", "-r", "-z", "-M",
      ...(parent ? [parent, oid] : ["--root", oid]), "--"])).toString("utf8").split("\0");
    const files: CommitDetails["files"] = [];
    for (let i = 0; i + 1 < records.length;) {
      const status = records[i++];
      const original = records[i++];
      if (/^[RC]/.test(status)) files.push({ status, originalPath: original, path: records[i++] });
      else files.push({ status, path: original });
    }
    return { oid, parent, message: raw.slice(separator + 1).replace(/\n$/, ""), files };
  }

  async commitDiff(oid: string, filePath: string): Promise<CommitDiff> {
    const details = await this.commitDetails(oid);
    const file = details.files.find((file) => file.path === filePath);
    if (!file) throw new Error("This file is not in the selected commit.");
    let reason: string | undefined;
    const text = async (revision: string | undefined, name: string): Promise<string> => {
      if (!revision) return "";
      const raw = (await this.run(["ls-tree", "-z", revision, "--", name])).toString("utf8");
      if (!raw) return "";
      const [mode, , blob] = raw.slice(0, raw.indexOf("\t")).split(" ");
      if (mode !== "100644" && mode !== "100755") {
        reason = "Symlinks and submodules have no text comparison here.";
        return "";
      }
      if (Number((await this.run(["cat-file", "-s", blob])).toString()) > LIMIT) {
        reason = "This file exceeds the 2 MB text comparison limit.";
        return "";
      }
      const buffer = await this.run(["cat-file", "blob", blob]);
      if (buffer.includes(0)) {
        reason = "Binary files have no text comparison here.";
        return "";
      }
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
      } catch {
        reason = "This file is not UTF-8 and has no text comparison here.";
        return "";
      }
    };
    const before = file.status[0] === "A" ? "" : await text(details.parent, file.originalPath || file.path);
    const after = file.status[0] === "D" ? "" : await text(oid, file.path);
    return { path: file.path, before: reason ? "" : before, after: reason ? "" : after, reason };
  }

  async branches(): Promise<BranchList> {
    const snapshot = await this.snapshot();
    // Only the first field has Git's record-separating newline. Paths can contain newlines.
    const raw = await this.run(["for-each-ref", "--sort=refname", "--format=%(refname)%00%(upstream:short)%00%(symref)%00%(worktreepath)%00%(objectname)%00", "refs/heads/", "refs/remotes/"]);
    const remotes = (await this.run(["remote"])).toString().trim().split("\n").filter(Boolean).sort((a, b) => b.length - a.length);
    const fields = raw.toString("utf8").split("\0");
    const branches: Branch[] = [];
    for (let i = 0; i + 4 < fields.length; i += 5) {
      const ref = fields[i].replace(/^\n/, "");
      const [upstream, symref, worktree] = fields.slice(i + 1, i + 4);
      if (symref) continue;
      const kind = ref.startsWith("refs/heads/") ? "local" : "remote";
      const name = ref.slice(kind === "local" ? 11 : 13);
      const remote = remotes.find((remote) => name.startsWith(remote + "/"));
      branches.push({ ref, name, kind, current: kind === "local" && name === snapshot.branch,
        upstream: upstream || undefined, worktree: worktree || undefined,
        localName: kind === "remote" && remote ? name.slice(remote.length + 1) : undefined });
    }
    return { branches, token: hash(Buffer.concat([raw, Buffer.from(snapshot.indexToken + "\0" + remotes.join("\0"))])) };
  }

  async switchBranch(ref: string, token: string): Promise<void> {
    const list = await this.branches();
    if (list.token !== token)
      throw new Error("The branches or staged files changed. Refresh the branch list before switching.");
    const branch = list.branches.find((branch) => branch.ref === ref);
    if (!branch) throw new Error("This branch is no longer available. Refresh the branch list.");
    if (branch.current) throw new Error("This branch is already checked out.");
    if (branch.worktree) throw new Error(`This branch is checked out in another worktree: ${branch.worktree}`);
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"]) {
      const gitPath = (await this.run(["rev-parse", "--git-path", marker])).toString().replace(/\r?\n$/, "");
      try {
        await fs.lstat(path.resolve(this.root, gitPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      throw new Error("Finish or abort the current Git operation before switching branches.");
    }
    if ((await this.snapshot()).changes.length)
      throw new Error("Commit or stash local changes before switching branches.");
    if ((await this.branches()).token !== token)
      throw new Error("The branches or staged files changed. Refresh the branch list before switching.");
    // No force, automatic guessing, ignored-file overwrite, or recursive submodule checkout.
    const args = ["switch", "--no-guess", "--no-overwrite-ignore", "--no-recurse-submodules"];
    if (branch.kind === "remote") {
      if (!branch.localName) throw new Error("The remote for this branch is no longer configured.");
      if (list.branches.some((local) => local.kind === "local" && local.name === branch.localName))
        throw new Error(`Local branch ${branch.localName} already exists. Select it in Local branches.`);
      await this.run(["check-ref-format", "--branch", branch.localName]);
      await this.run([...args, "--track", "--create", branch.localName, branch.ref]);
    } else {
      await this.run([...args, "--", branch.name]);
    }
  }

  async commit(message: string, indexToken: string): Promise<void> {
    if (!message.trim()) throw new Error("Enter a commit message.");
    const snapshot = await this.snapshot();
    if (snapshot.indexToken !== indexToken)
      throw new Error(
        "The staged files or branch changed. Review them before committing.",
      );
    if (snapshot.changes.some((change) => change.group === "conflict"))
      throw new Error(
        "Resolve all conflicts in this repository before committing.",
      );
    if (!snapshot.changes.some((change) => change.group === "staged"))
      throw new Error("Stage at least one file before committing.");
    await this.run(["commit", "-m", message], 120_000);
  }

  private async remoteBranch(indexToken: string) {
    const snapshot = await this.snapshot();
    if (snapshot.indexToken !== indexToken)
      throw new Error("The staged files or branch changed. Refresh before synchronizing.");
    let branch: string;
    try {
      branch = (await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"]))
        .toString().trim();
    } catch {
      throw new Error("Check out a branch before synchronizing (HEAD is detached).");
    }
    const config = async (key: string) => {
      try {
        return (await this.run(["config", "--get", key])).toString().trim();
      } catch {
        return "";
      }
    };
    const [remote, ref] = await Promise.all([
      config(`branch.${branch}.remote`),
      config(`branch.${branch}.merge`),
    ]);
    return { snapshot, branch, remote, ref };
  }

  async push(indexToken: string): Promise<void> {
    const target = await this.remoteBranch(indexToken);
    let { remote, ref } = target;
    if (!remote || !ref) {
      const remotes = (await this.run(["remote"])).toString().trim().split("\n").filter(Boolean);
      remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : "";
      if (!remote)
        throw new Error("Configure an upstream or a single remote (or origin) before pushing.");
      ref = `refs/heads/${target.branch}`;
    }
    // Explicit refspec: never let push.default=matching publish other branches.
    await this.run([
      "push", "--porcelain", "--set-upstream", "--", remote, `HEAD:${ref}`,
    ], 120_000);
  }

  async fetch(indexToken: string): Promise<void> {
    if ((await this.snapshot()).indexToken !== indexToken)
      throw new Error("The staged files or branch changed. Refresh before fetching.");
    // Fetch works for dirty worktrees, unborn branches and detached HEAD too.
    const remotes = (await this.run(["remote"])).toString().trim();
    if (!remotes) throw new Error("Configure a remote before fetching.");
    await this.run(["fetch", "--all"], 120_000);
  }

  async pull(indexToken: string): Promise<void> {
    const { snapshot, remote, ref } = await this.remoteBranch(indexToken);
    if (snapshot.changes.length)
      throw new Error("Commit or stash local changes before pulling.");
    if (!remote || !ref)
      throw new Error("This branch has no upstream. Push it first or configure its upstream.");
    await this.run([
      "pull", "--ff-only", "--no-rebase", "--no-autostash", "--", remote, ref,
    ], 120_000);
  }
}
