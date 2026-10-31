/**
 * 打 v3.3 分发包（版本号仍从 pages/server.mjs 读取，改版本只需改那里）。
 *
 * 规则（与 README「不要外发」一致）：
 *   - 不含 ai-config.env（含 API key）、backend/data/（含 token 与运行记录）、pages/data/（含用户需求）；
 *   - 不含 pages/public/data/h3-parts.v1.example.jsonc（本地注释版示例，不是给收件人看的）；
 *   - 保留 pages/data/README.txt、market-config.env.example 等占位与示例；
 *   - 版本号取 pages/server.mjs 里的 version，写进 zip 文件名。
 *
 * 用法：node scripts/build-package.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ATLAS = resolve(HERE, "..");
const OUT_DIR = resolve(ATLAS, "..");
const STAGE = join(OUT_DIR, "_tmp", "stage");

const version =
  readFileSync(join(ATLAS, "pages", "server.mjs"), "utf8").match(/version: "(\d+\.\d+\.\d+)"/)?.[1] ?? "";
const NAME = `atlas-v${version ? version.split(".").slice(0, 2).join(".") : "0.0"}`;
const DEST = join(STAGE, NAME);

const SKIP_FILES = new Set(["ai-config.env", ".env", "h3-parts.v1.example.jsonc"]);
const SKIP_DIRS = new Set(["node_modules", ".git"]);

function shouldSkip(rel, name) {
  if (SKIP_FILES.has(name)) return true;
  if (rel.startsWith("backend/data") || rel.startsWith("pages/data")) {
    // 只保留占位说明
    return !(name === "README.txt" && rel.split("/").length === 2);
  }
  return false;
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

for (const part of ["pages", "backend", "scripts"]) {
  if (!existsSync(join(ATLAS, part))) continue;
  cpSync(join(ATLAS, part), join(DEST, part), {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(ATLAS.length + 1).replaceAll("\\", "/");
      const base = rel.split("/").pop();
      if (SKIP_DIRS.has(base)) return false;
      return !shouldSkip(rel, base);
    },
  });
}
cpSync(join(ATLAS, "README.md"), join(DEST, "README.md"));

// pages/data 的占位说明必须留下
const dataReadme = join(ATLAS, "pages", "data", "README.txt");
if (existsSync(dataReadme)) {
  mkdirSync(join(DEST, "pages", "data"), { recursive: true });
  cpSync(dataReadme, join(DEST, "pages", "data", "README.txt"));
}

// 附一份不含 Key 的配置模板：优先用仓库里那份（手写注释更全），没有才从当前配置脱敏生成
const example = join(ATLAS, "ai-config.env.example");
const aiConfig = join(ATLAS, "ai-config.env");
if (existsSync(example)) {
  cpSync(example, join(DEST, "ai-config.env.example"));
} else if (existsSync(aiConfig)) {
  const sample = readFileSync(aiConfig, "utf8").replace(/^AI_API_KEY=.*$/m, "AI_API_KEY=");
  writeFileSync(join(DEST, "ai-config.env.example"), sample, "utf8");
}

const zipPath = join(OUT_DIR, `${NAME}.zip`);
rmSync(zipPath, { force: true });
const tar = spawnSync("tar.exe", ["-a", "-c", "-f", zipPath, "-C", STAGE, NAME], { stdio: "inherit" });
if (tar.status !== 0) {
  console.error("打包失败，tar 返回", tar.status);
  process.exit(1);
}
console.log("已生成", zipPath);
