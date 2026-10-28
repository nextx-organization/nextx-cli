// Standalone binaries get the version injected at build time (--define __CLI_VERSION__); npm installs read package.json.
import { createRequire } from "node:module";

declare const __CLI_VERSION__: string | undefined;

function read(): string {
  if (typeof __CLI_VERSION__ === "string") return __CLI_VERSION__;
  try {
    return (createRequire(import.meta.url)("../../package.json") as { version: string }).version;
  } catch {
    return "0.0.0-dev";
  }
}

export const VERSION: string = read();
