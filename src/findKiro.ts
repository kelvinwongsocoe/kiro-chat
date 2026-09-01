import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";

export interface KiroLocation {
  command: string;
  extraArgs: string[];
  source: string;
}

const isWindows = process.platform === "win32";

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

/** The places the Kiro installer normally puts the CLI on each system. */
function commonPaths(): string[] {
  const home = os.homedir();

  if (isWindows) {
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
      "C:\\Program Files\\Kiro-Cli\\kiro-cli.exe",
    ];
  }

  return [
    path.join(home, ".local", "bin", "kiro-cli"),
    path.join(home, ".kiro", "bin", "kiro-cli"),
    path.join(home, "bin", "kiro-cli"),
    "/usr/local/bin/kiro-cli",
    "/opt/homebrew/bin/kiro-cli",
    "/usr/bin/kiro-cli",
  ];
}

/**
 * Work out how to start Kiro without the user telling us.
 *
 * Order: the usual install folders, then whatever the system PATH knows,
 * then a login shell (which sees more than VS Code does on Mac and Linux),
 * and on Windows finally WSL, since older Kiro versions only ran there.
 */
export async function findKiro(log: (line: string) => void): Promise<KiroLocation | undefined> {
  for (const candidate of commonPaths()) {
    if (existsSync(candidate)) {
      log(`Found Kiro at ${candidate}`);
      return { command: candidate, extraArgs: [], source: "install folder" };
    }
  }

  const onPath = await run(isWindows ? "where" : "which", ["kiro-cli"]);
  if (onPath && existsSync(onPath)) {
    log(`Found Kiro on PATH at ${onPath}`);
    return { command: onPath, extraArgs: [], source: "PATH" };
  }

  if (!isWindows) {
    // VS Code often starts without your shell's PATH, so ask the shell itself.
    const shell = process.env.SHELL || "/bin/bash";
    const found = await run(shell, ["-lc", "command -v kiro-cli"]);
    if (found && existsSync(found)) {
      log(`Found Kiro on your shell PATH at ${found}`);
      return { command: found, extraArgs: [], source: "shell PATH" };
    }
  }

  if (isWindows) {
    const inWsl = await run("wsl", ["bash", "-lc", "command -v kiro-cli"]);
    if (inWsl) {
      log(`Found Kiro inside WSL at ${inWsl}. Running it through WSL.`);
      return { command: "wsl", extraArgs: ["kiro-cli"], source: "WSL" };
    }
  }

  log("Could not find kiro-cli anywhere.");
  return undefined;
}
