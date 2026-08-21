import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { SkillInstallRequest, SkillPackage } from "@uma-agent/protocol";
import YAML from "yaml";
import type { UmaDatabase } from "./database.js";
import type { SkillRegistry } from "./skills.js";

const MAX_FILES = 200;
const MAX_BYTES = 10 * 1024 * 1024;
const suspicious = [
  [/rm\s+-rf|Remove-Item\s+.*-Recurse/i, "destructive recursive deletion"],
  [/curl\s+\S+\s*\|\s*(?:ba)?sh|wget\s+\S+.*\|\s*(?:ba)?sh/i, "remote script execution"],
  [/\b(?:eval|exec)\s*\(|new\s+Function\s*\(/i, "dynamic code execution"],
  [/child_process|Deno\.Command|Bun\.spawn/i, "process execution"],
  [
    /(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][A-Za-z0-9+/=_-]{16,}/i,
    "possible embedded credential",
  ],
] as const;

interface PackageFile {
  path: string;
  bytes: Uint8Array;
}

function safeRelative(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes(".."))
    throw new Error(`Unsafe skill path: ${value}`);
  return normalized;
}

async function localFiles(root: string): Promise<PackageFile[]> {
  const canonical = resolve(root);
  const output: PackageFile[] = [];
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`Skill packages cannot contain symlinks: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const rel = safeRelative(relative(canonical, path));
        const bytes = await readFile(path);
        total += bytes.byteLength;
        if (output.length + 1 > MAX_FILES || total > MAX_BYTES)
          throw new Error("Skill package exceeds limits");
        output.push({ path: rel, bytes });
      }
    }
  };
  await visit(canonical);
  return output;
}

function inspect(files: PackageFile[]): {
  name: string;
  version: string;
  hash: string;
  diagnostics: string[];
  risk: SkillPackage["risk"];
} {
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) throw new Error("Skill package must contain a root SKILL.md");
  const raw = new TextDecoder().decode(skill.bytes);
  const front = raw.startsWith("---\n") ? raw.slice(4, raw.indexOf("\n---\n", 4)) : "";
  const metadata = (front ? YAML.parse(front) : {}) as Record<string, unknown>;
  const name = typeof metadata.name === "string" ? metadata.name : "";
  const version = typeof metadata.version === "string" ? metadata.version : "1.0.0";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("Invalid skill name");
  const diagnostics: string[] = [];
  let executable = false;
  for (const file of files) {
    if (/\.(?:js|mjs|cjs|ts|py|sh|ps1)$/i.test(file.path)) executable = true;
    if (file.bytes.byteLength > 1_000_000) continue;
    const content = new TextDecoder().decode(file.bytes);
    for (const [pattern, message] of suspicious)
      if (pattern.test(content)) diagnostics.push(`${message}: ${file.path}`);
  }
  if (executable) diagnostics.push("Executable files require an isolated MCP/Skill Worker");
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update(file.bytes);
  }
  const risk: SkillPackage["risk"] = diagnostics.some((item) => item.includes("credential"))
    ? "extreme"
    : diagnostics.some((item) => /destructive|remote script|dynamic/.test(item))
      ? "high"
      : executable
        ? "medium"
        : "low";
  return { name, version, hash: hash.digest("hex"), diagnostics: [...new Set(diagnostics)], risk };
}

export class SkillPackageService {
  private readonly stageRoot: string;
  private readonly enabledRoot: string;

  constructor(
    stateDir: string,
    private readonly database: UmaDatabase,
    private readonly registry: SkillRegistry,
    private readonly invalidated: () => void,
  ) {
    this.stageRoot = join(stateDir, "skill-staging");
    this.enabledRoot = join(stateDir, "managed-skills");
    this.registry.addRoot(this.enabledRoot);
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.stageRoot, { recursive: true }),
      mkdir(this.enabledRoot, { recursive: true }),
    ]);
  }

  list(): SkillPackage[] {
    return this.database.listSkillPackages();
  }

  reconfigureRoots(roots: string[]): void {
    this.registry.replaceRoots([...roots, this.enabledRoot]);
  }

  async install(input: SkillInstallRequest): Promise<SkillPackage> {
    const files =
      input.source === "local" ? await localFiles(input.reference) : await this.download(input.reference);
    const checked = inspect(files);
    const stage = join(this.stageRoot, `${checked.name}-${randomUUID()}`);
    const previous = this.database.listSkillPackages().find((item) => item.name === checked.name);
    const previousPath = previous ? this.database.getSkillPackagePath(previous.id) : undefined;
    try {
      await mkdir(stage, { recursive: true });
      for (const file of files) {
        const path = join(stage, ...safeRelative(file.path).split("/"));
        const relativePath = relative(stage, path);
        if (relativePath.startsWith(`..${sep}`) || relativePath === "..")
          throw new Error("Skill path escaped staging");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes);
      }
      const result = this.database.upsertSkillPackage({
        name: checked.name,
        version: input.version ?? checked.version,
        source: { type: input.source, reference: input.reference },
        contentHash: checked.hash,
        status: "staged",
        risk: checked.risk,
        diagnostics: checked.diagnostics,
        installPath: stage,
      });
      if (previousPath && previousPath !== stage) await rm(previousPath, { recursive: true, force: true });
      this.invalidated();
      return result;
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }

  async setStatus(id: string, status: "enabled" | "disabled" | "rejected"): Promise<SkillPackage> {
    const pkg = this.database.getSkillPackage(id);
    const destination = join(this.enabledRoot, pkg.name);
    if (status === "enabled") {
      if (pkg.risk === "extreme") throw new Error("Extreme-risk skills cannot be enabled");
      const source = this.database.getSkillPackagePath(id);
      const temporary = `${destination}.new-${randomUUID()}`;
      await cp(source, temporary, { recursive: true, errorOnExist: true });
      await rm(destination, { recursive: true, force: true });
      await rename(temporary, destination);
    } else {
      await rm(destination, { recursive: true, force: true });
      if (status === "rejected")
        await rm(this.database.getSkillPackagePath(id), { recursive: true, force: true });
    }
    const updated = this.database.updateSkillPackageStatus(id, status);
    await this.registry.refresh();
    this.invalidated();
    return updated;
  }

  async search(query: string): Promise<Array<Record<string, unknown>>> {
    const url = new URL("https://clawhub.ai/api/v1/skills/search");
    url.searchParams.set("q", query);
    url.searchParams.set("limit", "20");
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`ClawHub search failed: HTTP ${response.status}`);
    const value = (await response.json()) as { items?: Array<Record<string, unknown>> };
    return value.items ?? [];
  }

  private async download(slug: string): Promise<PackageFile[]> {
    const response = await fetch(`https://clawhub.ai/api/v1/skills/${encodeURIComponent(slug)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`ClawHub download failed: HTTP ${response.status}`);
    const value = (await response.json()) as { files?: Array<{ path?: string; content?: string }> };
    const files = (value.files ?? []).flatMap((file) =>
      file.path && typeof file.content === "string"
        ? [{ path: safeRelative(file.path), bytes: new TextEncoder().encode(file.content) }]
        : [],
    );
    if (!files.length || files.length > MAX_FILES) throw new Error("ClawHub returned an invalid package");
    if (files.reduce((sum, file) => sum + file.bytes.byteLength, 0) > MAX_BYTES)
      throw new Error("Skill package exceeds limits");
    return files;
  }
}
