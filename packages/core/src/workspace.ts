import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function closestExisting(path: string): Promise<{ existing: string; suffix: string[] }> {
  const suffix: string[] = [];
  let current = path;
  while (true) {
    try {
      await lstat(current);
      return { existing: current, suffix };
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error(`No existing parent for path: ${path}`);
      suffix.unshift(current.slice(parent.length).replace(/^[/\\]+/, ""));
      current = parent;
    }
  }
}

export class WorkspacePolicy {
  private roots: string[] = [];

  constructor(private readonly configuredRoots: string[]) {}

  async initialize(): Promise<void> {
    this.roots = await Promise.all(this.configuredRoots.map((root) => realpath(resolve(root))));
  }

  async validateWorkspace(path: string): Promise<string> {
    const canonical = await realpath(resolve(path));
    if (!this.roots.some((root) => inside(root, canonical)))
      throw new Error("Workspace is outside allowed roots");
    const stat = await lstat(canonical);
    if (!stat.isDirectory()) throw new Error("Workspace must be a directory");
    return canonical;
  }

  async resolvePath(workspace: string, input: string, allowMissing = false): Promise<string> {
    const root = await this.validateWorkspace(workspace);
    const addressed = resolve(root, input);
    if (!inside(root, addressed)) throw new Error("Path escapes the session workspace");
    if (!allowMissing) {
      const canonical = await realpath(addressed);
      if (!inside(root, canonical)) throw new Error("Path resolves outside the session workspace");
      return canonical;
    }
    const { existing, suffix } = await closestExisting(addressed);
    const canonicalParent = await realpath(existing);
    if (!inside(root, canonicalParent)) throw new Error("Path parent resolves outside the session workspace");
    return resolve(canonicalParent, ...suffix);
  }
}
