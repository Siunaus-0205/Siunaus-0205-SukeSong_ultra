/**
 * 1688 连通性自检：只发一个请求，判断「直连 + 当前 Cookie」能不能拿到真实商品页。
 *
 * 用法：
 *   node scripts/check-1688.mjs                 # 用 seeds 里的第一条链接
 *   node scripts/check-1688.mjs 1072723637966   # 指定 offerId
 *
 * 退出码：0 = 正常拿到商品页；2 = 被滑块风控；3 = 跳到登录页；1 = 其它错误。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { APP_DIR, loadConfig } from "../lib/config.mjs";
import { probeOffer } from "../lib/source-1688.mjs";

const config = loadConfig();
const seedsFile = config.seeds1688File;

let id = process.argv[2] || "";
if (!id && existsSync(seedsFile)) {
  try {
    const seeds = JSON.parse(readFileSync(seedsFile, "utf8"));
    const first = Object.entries(seeds).find(([key]) => !key.startsWith("$"));
    const list = first ? (Array.isArray(first[1]) ? first[1] : [first[1]]) : [];
    id = String(list[0] ?? "").match(/(\d{10,16})/)?.[1] ?? "";
  } catch {
    /* 种子文件坏了就要求显式传 id */
  }
}

if (!id) {
  console.error("没有可用 offerId：传一个，或在 seeds/1688-seeds.json 里写一条链接。");
  process.exit(1);
}

const cookie = config.cookie1688;
const direct = config.direct1688;

console.log("== 1688 自检 ==");
console.log("  offerId :", id);
console.log("  连接    :", direct ? "直连（绕开系统代理）" : "走系统代理");
console.log("  Cookie  :", cookie ? `已配置（${cookie.length} 字符）` : "未配置（匿名）");
console.log("  Cookie文件:", config.cookie1688File);
console.log("  种子文件:", seedsFile);

let result;
try {
  result = await probeOffer(id, { cookie, direct });
} catch (error) {
  console.error("  请求失败:", error.message);
  process.exit(1);
}

console.log("  HTTP    :", result.status, `（${result.length} 字节）`);

if (result.blocked) {
  console.log("  结论    : ❌ 被滑块风控（____tmd____/punish 页面）");
  console.log("  下一步  : ① 等 30~60 分钟不访问；② 配 MARKET_1688_COOKIE；③ 把 MARKET_1688_DELAY_MS 调到 30000+。");
  process.exit(2);
}
if (result.loginWall) {
  console.log("  结论    : ⚠️ 跳到登录页，当前 Cookie 无效或已过期");
  process.exit(3);
}

const parsed = result.parsed;
console.log("  结论    : ✅ 可以抓取");
console.log("  标题    :", parsed.title);
console.log("  公司    :", parsed.company);
console.log("  价格    :", parsed.price ? `¥${parsed.price}` : "-", parsed.tiers.length ? `（阶梯 ${parsed.tiers.length} 档）` : "");
console.log("  已售    :", parsed.soldText || parsed.sold, parsed.unit);
console.log("  型号    :", parsed.model || "-", "| 属性", parsed.attrs.length, "条");
process.exit(0);
