#!/usr/bin/env node
/**
 * quack installer — Node phase.
 *
 * Called by `install/install.sh` after the bash bootstrap has:
 *   1. Ensured Node 18+ is available (system or bundled at `~/.quack/node`)
 *   2. Downloaded and extracted the `@modelworks/quack` npm tarball to a temp dir
 *
 * This script (from the extracted tarball's `dist/install.js`):
 *   1. Copies `dist/` to `~/.quack/dist`
 *   2. Creates the `~/.quack/bin/quack` wrapper
 *   3. Configures PATH (shell config file)
 *   4. Handles GitHub Actions (`$GITHUB_PATH`)
 *   5. Prints a success summary
 *
 * Each step shows a spinner while running, then ✓ (green) or ✗ (red).
 *
 * Usage:
 *   node dist/install.js [--target <dir>] [--no-modify-path] [--version <ver>] [--bundled-node]
 *
 * @module
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const isTTY: boolean = process.stderr.isTTY ?? false;

const C = isTTY
  ? {
      reset: "\x1b[0m",
      bold: "\x1b[1m",
      dim: "\x1b[2m",
      red: "\x1b[31m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      blue: "\x1b[34m",
      gray: "\x1b[90m",
      hide: "\x1b[?25l",
      show: "\x1b[?25h",
      clearLine: "\x1b[2K",
    }
  : {
      reset: "",
      bold: "",
      dim: "",
      red: "",
      green: "",
      yellow: "",
      blue: "",
      gray: "",
      hide: "",
      show: "",
      clearLine: "",
    };

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private msg = "";

  start(msg: string): void {
    this.msg = msg;
    this.stop();
    if (isTTY) process.stderr.write(C.hide);
    this.timer = setInterval(() => {
      process.stderr.write(
        `\r${C.clearLine}${C.gray}${FRAMES[this.frame % FRAMES.length]}${C.reset} ${this.msg}`,
      );
      this.frame++;
    }, 80);
  }

  succeed(msg?: string): void {
    this.stop();
    process.stderr.write(
      `\r${C.clearLine}${C.green}✓${C.reset} ${msg ?? this.msg}\n`,
    );
  }

  fail(msg?: string): void {
    this.stop();
    process.stderr.write(
      `\r${C.clearLine}${C.red}✗${C.reset} ${msg ?? this.msg}\n`,
    );
  }

  warn(msg: string): void {
    this.stop();
    process.stderr.write(
      `\r${C.clearLine}${C.yellow}!${C.reset} ${msg}\n`,
    );
  }

  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (isTTY) process.stderr.write(C.show);
  }
}

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

interface InstallArgs {
  target?: string;
  noModifyPath: boolean;
  version?: string;
  bundledNode: boolean;
}

function parseArgs(argv: string[]): InstallArgs {
  const args: InstallArgs = { noModifyPath: false, bundledNode: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--target":
        args.target = argv[++i];
        break;
      case "--no-modify-path":
        args.noModifyPath = true;
        break;
      case "--version":
        args.version = argv[++i];
        break;
      case "--bundled-node":
        args.bundledNode = true;
        break;
      case "--help":
      case "-h":
        console.log(
          "Usage: quack-install [--target <dir>] [--no-modify-path] [--version <ver>] [--bundled-node]",
        );
        process.exit(0);
        break;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/** Recursively copy a directory. */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// ---------------------------------------------------------------------------
// PATH configuration
// ---------------------------------------------------------------------------

interface PathResult {
  added: boolean;
  already: boolean;
  noConfig: boolean;
  file?: string;
}

function configurePath(binDir: string): PathResult {
  // Already on PATH?
  const pathParts = (process.env.PATH ?? "").split(":");
  if (pathParts.includes(binDir)) {
    return { added: false, already: true, noConfig: false };
  }

  const home = os.homedir();
  const shell = path.basename(process.env.SHELL ?? "");
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");

  let configFiles: string[];
  let pathCmd: string;

  switch (shell) {
    case "fish":
      configFiles = [path.join(home, ".config/fish/config.fish")];
      pathCmd = `fish_add_path ${binDir}`;
      break;
    case "zsh":
      configFiles = [
        path.join(process.env.ZDOTDIR ?? home, ".zshrc"),
        path.join(process.env.ZDOTDIR ?? home, ".zshenv"),
        path.join(xdgConfig, "zsh/.zshrc"),
        path.join(xdgConfig, "zsh/.zshenv"),
      ];
      pathCmd = `export PATH="${binDir}:$PATH"`;
      break;
    case "bash":
      configFiles = [
        path.join(home, ".bashrc"),
        path.join(home, ".bash_profile"),
        path.join(home, ".profile"),
      ];
      pathCmd = `export PATH="${binDir}:$PATH"`;
      break;
    default:
      configFiles = [
        path.join(home, ".bashrc"),
        path.join(home, ".bash_profile"),
        path.join(home, ".profile"),
      ];
      pathCmd = `export PATH="${binDir}:$PATH"`;
  }

  // Find first existing config file.
  const configFile = configFiles.find((f) => fs.existsSync(f));
  if (!configFile) {
    return { added: false, already: false, noConfig: true };
  }

  // Already in config?
  const content = fs.readFileSync(configFile, "utf8");
  if (content.includes(pathCmd)) {
    return { added: false, already: true, noConfig: false };
  }

  // Append.
  fs.appendFileSync(configFile, `\n# quack\n${pathCmd}\n`);
  return { added: true, already: false, noConfig: false, file: configFile };
}

// ---------------------------------------------------------------------------
// Wrapper script
// ---------------------------------------------------------------------------

const WRAPPER_SCRIPT = `#!/bin/sh
# quack wrapper — resolves Node (system or bundled) and launches quack.
set -e
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
QUACK_HOME="$(cd "$SELF_DIR/.." && pwd)"
if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
elif [ -x "$QUACK_HOME/node/node" ]; then
  NODE_BIN="$QUACK_HOME/node/node"
else
  echo "quack: Node 18+ not found. Reinstall:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/modelworks-ai/quack/main/install/install.sh | bash" >&2
  exit 1
fi
exec "$NODE_BIN" "$QUACK_HOME/dist/bin.js" "$@"
`;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function printSummary(
  args: InstallArgs,
  binDir: string,
): void {
  const version = args.version ?? "latest";
  const shell = path.basename(process.env.SHELL ?? "");

  console.log("");
  console.log(`  ${C.green}${C.bold}╔══════════════════════════════════════╗${C.reset}`);
  console.log(`  ${C.green}${C.bold}║          quack installed! 🦆           ║${C.reset}`);
  console.log(`  ${C.green}${C.bold}╚══════════════════════════════════════╝${C.reset}`);
  console.log("");
  console.log(`  ${C.dim}Version:${C.reset}  ${version}`);
  console.log(`  ${C.dim}Location:${C.reset} ${binDir}/quack`);
  if (args.bundledNode) {
    console.log(`  ${C.dim}Node:${C.reset}     bundled`);
  }
  console.log("");
  console.log(`  ${C.bold}Next steps:${C.reset}`);
  console.log(
    `    quack login                              ${C.dim}# Authenticate via OAuth${C.reset}`,
  );
  console.log(
    `    cd <project> && quack init               ${C.dim}# Initialize a project${C.reset}`,
  );
  console.log(
    `    quack add <circuit-url>                  ${C.dim}# Add a circuit${C.reset}`,
  );
  console.log(
    `    quack opencode                           ${C.dim}# Launch OpenCode${C.reset}`,
  );
  console.log("");
  if (!args.noModifyPath) {
    console.log(`  ${C.dim}Open a new terminal or run:${C.reset}`);
    if (shell) {
      console.log(
        `  ${C.dim}  source ~/.${shell}rc  # or restart your shell${C.reset}`,
      );
    }
    console.log(`  ${C.dim}to use quack.${C.reset}`);
  } else {
    console.log(
      `  ${C.dim}Add to PATH: export PATH="${binDir}:$PATH"${C.reset}`,
    );
  }
  console.log("");
  console.log(`  ${C.dim}Docs: https://github.com/modelworks-ai/quack${C.reset}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const installDir = args.target ?? path.join(os.homedir(), ".quack");
  const binDir = path.join(installDir, "bin");
  const distDir = path.join(installDir, "dist");

  // Source dist files are in the same directory as this script (the
  // extracted tarball's dist/).
  const sourceDist = path.dirname(fileURLToPath(import.meta.url));

  const spinner = new Spinner();

  // Step 1: Copy dist to install dir.
  spinner.start("Installing quack...");
  try {
    fs.mkdirSync(installDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.rmSync(distDir, { recursive: true, force: true });
    copyDir(sourceDist, distDir);
    spinner.succeed(`Installed to ${installDir}`);
  } catch (err) {
    spinner.fail("Installation failed");
    console.error(err);
    process.exit(1);
  }

  // Step 2: Create wrapper.
  spinner.start("Creating wrapper script...");
  try {
    fs.writeFileSync(path.join(binDir, "quack"), WRAPPER_SCRIPT, {
      mode: 0o755,
    });
    spinner.succeed(`Created ${path.join(binDir, "quack")}`);
  } catch (err) {
    spinner.fail("Failed to create wrapper");
    console.error(err);
    process.exit(1);
  }

  // Step 3: Configure PATH.
  if (!args.noModifyPath) {
    spinner.start("Configuring PATH...");
    try {
      const result = configurePath(binDir);
      if (result.added) {
        spinner.succeed(`Added to PATH in ${result.file}`);
      } else if (result.already) {
        spinner.succeed("Already on PATH");
      } else if (result.noConfig) {
        spinner.warn(
          `No shell config found. Add manually:\n    export PATH="${binDir}:$PATH"`,
        );
      }
    } catch (err) {
      spinner.fail("PATH configuration failed");
      console.error(err);
    }
  }

  // Step 4: GitHub Actions.
  if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_PATH) {
    spinner.start("Adding to $GITHUB_PATH...");
    try {
      fs.appendFileSync(process.env.GITHUB_PATH, binDir + "\n");
      spinner.succeed(`Added ${binDir} to $GITHUB_PATH`);
    } catch {
      spinner.warn("Could not write to $GITHUB_PATH");
    }
  }

  // Summary.
  printSummary(args, binDir);
}

main().catch((err) => {
  console.error(`${C.red}Error: ${err.message}${C.reset}`);
  process.exit(1);
});
