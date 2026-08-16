import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type IsolatedRunDirs = {
  workDir: string;
  evidenceDir: string;
};

export type ComparisonRunDirs = {
  baseline: IsolatedRunDirs;
  candidate: IsolatedRunDirs;
};

async function createRunDirs(prefix: string): Promise<IsolatedRunDirs> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workDir = join(root, "work");
  const evidenceDir = join(root, "evidence");
  await mkdir(workDir, { recursive: true });
  await mkdir(evidenceDir, { recursive: true });
  return { workDir, evidenceDir };
}

export async function createComparisonRunDirs(): Promise<ComparisonRunDirs> {
  const baseline = await createRunDirs("cuse-compare-baseline-");
  const candidate = await createRunDirs("cuse-compare-candidate-");
  return { baseline, candidate };
}

export async function cleanupComparisonRunDirs(dirs: ComparisonRunDirs): Promise<void> {
  await rm(dirname(dirs.baseline.workDir), { recursive: true, force: true });
  await rm(dirname(dirs.candidate.workDir), { recursive: true, force: true });
}
