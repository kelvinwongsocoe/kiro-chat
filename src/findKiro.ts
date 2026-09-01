import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";

export interface KiroLocation {
  command: string;
  extraArgs: string[];
  source: string;
}

function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 5000 }, (err, stdout) => {
      if (err || !stdout) {
        resolve(undefined);
        return;
      }
      const first = stdout.toString().split("\n")[0]?.trim();
      resolve(first || undefined);
    });
  });
}

/** The places the Kiro installer normally puts the CLI on Windows. */
function commonPaths(): string[] {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";

  return [
    // Where the current Windows installer actually puts it.
    path.join(localAppData, "Kiro-Cli", "kiro-cli.exe"),
    path.join(localAppData, "Programs", "kiro-cli", "kiro-cli.exe"),
    path.join(localAppData, "kiro-cli", "bin", "kiro-cli.exe"),
    path.join(localAppData, "Kiro", "bin", "kiro-cli.exe"),
    path.join(home, ".kiro", "bin", "kiro-cli.exe"),
    path.join(home, ".local", "bin", "kiro-cli.exe"),
    path.join(programFiles, "Kiro-Cli", "kiro-cli.exe"),
    path.join(programFiles, "Kiro", "kiro-cli.exe"),
  ];
}

/**
 * Work out how to start Kiro without the user telling us.
 *
 * Order: the usual install folders, then whatever the system PATH knows, and
 * finally WSL, since older Kiro versions only ran there.
 */
export async function findKiro(log: (line: string) => void): Promise<KiroLocation | undefined> {
  for (const candidate of commonPaths()) {
    if (existsSync(candidate)) {
      log(`Found Kiro at ${candidate}`);
      return { command: candidate, extraArgs: [], source: "install folder" };
    }
  }

  const onPath = await run("where", ["kiro-cli"]);
  if (onPath && existsSync(onPath)) {
    log(`Found Kiro on PATH at ${onPath}`);
    return { command: onPath, extraArgs: [], source: "PATH" };
  }

  const inWsl = await run("wsl", ["bash", "-lc", "command -v kiro-cli"]);
  if (inWsl) {
    log(`Found Kiro inside WSL at ${inWsl}. Running it through WSL.`);
    return { command: "wsl", extraArgs: ["kiro-cli"], source: "WSL" };
  }

  log("Could not find kiro-cli anywhere.");
  return undefined;
}
