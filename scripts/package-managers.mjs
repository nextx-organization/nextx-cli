// Writes the Homebrew formula and Scoop manifest for a release from SHA256SUMS. Run inside the release assets folder.
//   node package-managers.mjs <version> SHA256SUMS
import { readFileSync, writeFileSync } from "node:fs";

const [version, sums] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const bin = Object.keys(pkg.bin)[0];
const repo = pkg.repository.url.replace(/^git\+https:\/\/github\.com\//, "").replace(/\.git$/, "");
const sha = Object.fromEntries(readFileSync(sums, "utf8").trim().split("\n").map((l) => l.split(/\s+/).reverse()));
const url = (f) => `https://github.com/${repo}/releases/download/v${version}/${f}`;
const asset = (os, arch, ext = "tar.gz") => `${bin}-${os}-${arch}.${ext}`;
const cls = bin.charAt(0).toUpperCase() + bin.slice(1).replace(/-(\w)/g, (_, c) => c.toUpperCase());

// Homebrew audit: under 80 characters and not starting with the formula name.
const ai = /chat with (.+?) on /.exec(pkg.description)?.[1] ?? "the assistant";
const desc = `Command-line client for ${ai}: chat, API, keys and webhooks`;
if (desc.length >= 80) throw new Error(`formula desc too long: ${desc}`);

const block = (os, arch) => `      url "${url(asset(os, arch))}"\n      sha256 "${sha[asset(os, arch)]}"`;
writeFileSync(`${bin}.rb`, `class ${cls} < Formula
  desc "${desc}"
  homepage "${pkg.homepage}"
  license "MIT"

  livecheck do
    url :stable
    strategy :github_latest
  end

  on_macos do
    on_arm do
${block("darwin", "arm64")}
    end
    on_intel do
${block("darwin", "x64")}
    end
  end

  on_linux do
    on_arm do
${block("linux", "arm64")}
    end
    on_intel do
${block("linux", "x64")}
    end
  end

  def install
    bin.install "${bin}"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/${bin} --version")
  end
end
`);

writeFileSync(`${bin}.json`, `${JSON.stringify({
  version,
  description: pkg.description,
  homepage: pkg.homepage,
  license: "MIT",
  architecture: { "64bit": { url: url(asset("windows", "x64", "zip")), hash: sha[asset("windows", "x64", "zip")] } },
  bin: `${bin}.exe`,
  checkver: { github: `https://github.com/${repo}` },
  autoupdate: { architecture: { "64bit": { url: `https://github.com/${repo}/releases/download/v$version/${bin}-windows-x64.zip` } } },
}, null, 2)}\n`);
console.log(`wrote ${bin}.rb and ${bin}.json for ${version}`);
