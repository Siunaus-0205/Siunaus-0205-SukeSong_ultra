#!/usr/bin/env node
/**
 * 生成 28 张「零件类别示意图」（SVG，每个零件类型一张，同类 10 个型号共用）。
 *
 * 为什么自己画：交付包里不能依赖外链图片（评委机器多半离线），也不该背图片版权；
 * 28 类零件的真实照片来源零散、背景与光照各不相同，拼在深色详情栏里反而不像一套东西。
 * 这里统一成同一套「工程图版式」：暗底 + 网格 + 单色线稿 + 尺寸标注 + 图版编号，
 * 放大到 2 倍屏也是矢量清晰的，整包只占 100 KB 出头。
 *
 * 想换成实拍图：把 data/parts/<零件类型代码>.svg 换成同名 .jpg/.webp，再改
 * pages/public/next.js 里 partArtUrl() 的扩展名即可，其余代码不用动。
 *
 * 用法：
 *   node atlas/scripts/gen-part-art.mjs            # 只校验并打印清单
 *   node atlas/scripts/gen-part-art.mjs --write    # 写出 28 个 svg + manifest.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = fileURLToPath(new URL("../pages/public/data/parts/", import.meta.url));

/* ------------------------------------------------------------------ */
/* 七个模块的强调色：同一模块的 4 张图同色，28 张图共用一套版式         */
/* ------------------------------------------------------------------ */

const MODULES = {
  cam: { code: "h3-cam", name: "相机与成像", en: "CAMERA / IMAGING", ink: "#6ee7d0" },
  pit: { code: "h3-pit", name: "俯仰轴总成", en: "TILT ASSEMBLY", ink: "#7dd3fc" },
  rol: { code: "h3-rol", name: "横滚轴总成", en: "ROLL ASSEMBLY", ink: "#a5b4fc" },
  yaw: { code: "h3-yaw", name: "航向轴总成", en: "PAN ASSEMBLY", ink: "#c4b5fd" },
  hnd: { code: "h3-hnd", name: "手柄与人机", en: "HANDLE / HMI", ink: "#f7cf94" },
  ctl: { code: "h3-ctl", name: "控制电子", en: "CONTROL ELECTRONICS", ink: "#86efac" },
  pwr: { code: "h3-pwr", name: "电源与线束", en: "POWER / HARNESS", ink: "#fca5a5" },
};

/* ------------------------------------------------------------------ */
/* 画法工具箱：全部返回 SVG 片段字符串                                  */
/* ------------------------------------------------------------------ */

const n = (value) => Math.round(value * 100) / 100;

const k = {
  rr: (x, y, w, h, r = 3, cls = "f") =>
    `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${r}" class="${cls}"/>`,
  poly: (points, cls = "f") =>
    `<polygon points="${points.map(([x, y]) => `${n(x)},${n(y)}`).join(" ")}" class="${cls}"/>`,
  ln: (x1, y1, x2, y2, cls = "l") =>
    `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" class="${cls}"/>`,
  c: (cx, cy, r, cls = "l") => `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" class="${cls}"/>`,
  e: (cx, cy, rx, ry, cls = "l") =>
    `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" class="${cls}"/>`,
  p: (d, cls = "l") => `<path d="${d}" class="${cls}"/>`,
  t: (x, y, text, cls = "k", anchor = "start") =>
    `<text x="${n(x)}" y="${n(y)}" class="${cls}" text-anchor="${anchor}">${text}</text>`,
  /** 横向尺寸线（两端小竖线 + 居中文字） */
  dimH: (x1, x2, y, label) =>
    [
      k.ln(x1, y - 4, x1, y + 4, "t"),
      k.ln(x2, y - 4, x2, y + 4, "t"),
      k.ln(x1, y, x2, y, "t"),
      `<text x="${n((x1 + x2) / 2)}" y="${n(y - 6)}" class="k2" text-anchor="middle">${label}</text>`,
    ].join(""),
  /** 纵向尺寸线 */
  dimV: (y1, y2, x, label) =>
    [
      k.ln(x - 4, y1, x + 4, y1, "t"),
      k.ln(x - 4, y2, x + 4, y2, "t"),
      k.ln(x, y1, x, y2, "t"),
      `<text x="${n(x + 7)}" y="${n((y1 + y2) / 2 + 2)}" class="k2">${label}</text>`,
    ].join(""),
  /** 引出线：从 (x1,y1) 拐到 (x2,y2) 再写标签 */
  lead: (x1, y1, x2, y2, label, anchor = "start") =>
    [
      k.ln(x1, y1, x2, y2, "h"),
      k.c(x1, y1, 1.4, "s"),
      `<text x="${n(x2 + (anchor === "end" ? -3 : 3))}" y="${n(y2 + 2)}" class="k2" text-anchor="${anchor}">${label}</text>`,
    ].join(""),
  /** 装 6 颗小球/线圈的圆周排布 */
  ring: (cx, cy, radius, count, r, cls = "l", phase = -Math.PI / 2) =>
    Array.from({ length: count }, (_, i) => {
      const a = phase + (i / count) * Math.PI * 2;
      return k.c(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius, r, cls);
    }).join(""),
  /** 斜线剖面填充（用 clipPath 限定范围） */
  hatch: (id, x, y, w, h, gap = 6) =>
    [
      `<clipPath id="${id}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/></clipPath>`,
      `<g clip-path="url(#${id})">${Array.from({ length: Math.ceil((w + h) / gap) + 2 }, (_, i) => {
        const off = x - h + i * gap;
        return k.ln(off, y + h, off + h, y, "h");
      }).join("")}</g>`,
    ].join(""),
  /** 一排焊盘 */
  pads: (x, y, count, step, w = 6, h = 4) =>
    Array.from({ length: count }, (_, i) => k.rr(x + i * step, y, w, h, 1, "s")).join(""),
};

/* ------------------------------------------------------------------ */
/* 版式：暗底 + 网格 + 角落标记 + 图版编号                              */
/* ------------------------------------------------------------------ */

const STYLE = `
.l{fill:none;stroke:var(--ink);stroke-width:1.15;stroke-linecap:round;stroke-linejoin:round;opacity:.95}
.f{fill:rgba(255,255,255,.055);stroke:var(--ink);stroke-width:1.15;stroke-linejoin:round}
.f2{fill:rgba(255,255,255,.014);stroke:var(--ink);stroke-width:1.1;stroke-linejoin:round}
.fi{fill:var(--ink);fill-opacity:.14;stroke:var(--ink);stroke-width:1.15;stroke-linejoin:round}
.fs{fill:#05080c;stroke:var(--ink);stroke-width:1.15;stroke-linejoin:round}
.t{fill:none;stroke:var(--ink);stroke-width:.95;opacity:.42}
.d{fill:none;stroke:var(--ink);stroke-width:.95;opacity:.5;stroke-dasharray:4 4}
.h{fill:none;stroke:var(--ink);stroke-width:.75;opacity:.4}
.s{fill:var(--ink);opacity:.6}
.k{font:6.4px ui-monospace,Consolas,monospace;fill:#9fb0c2;letter-spacing:.1em}
.k2{font:5.8px ui-monospace,Consolas,monospace;fill:#7e8fa1;letter-spacing:.06em}
.k3{font:7.4px ui-monospace,Consolas,monospace;fill:var(--ink);letter-spacing:.14em;opacity:.9}
`;

function frame({ code, mod, index, title, body }) {
  // SVG 是严格 XML：标题里的 & 必须转义，否则整张图解析失败（浏览器只显示破图）。
  const esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const corners = [
    [10, 10, 1, 1],
    [310, 10, -1, 1],
    [10, 230, 1, -1],
    [310, 230, -1, -1],
  ]
    .map(([x, y, dx, dy]) =>
      k.ln(x, y, x + 9 * dx, y, "h") + k.ln(x, y, x, y + 9 * dy, "h"),
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240" width="320" height="240" role="img" style="--ink:${mod.ink}">
<title>${esc(title)}</title>
<defs>
<style>${STYLE}</style>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#0d141c"/><stop offset="1" stop-color="#070b10"/>
</linearGradient>
<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">
<path d="M24 0H0V24" fill="none" stroke="rgba(255,255,255,.038)" stroke-width="1"/>
</pattern>
<filter id="soft" x="-40%" y="-200%" width="180%" height="500%">
<feGaussianBlur stdDeviation="6"/>
</filter>
</defs>
<rect width="320" height="240" fill="url(#bg)"/>
<rect width="320" height="240" fill="url(#grid)"/>
<circle cx="160" cy="116" r="104" fill="var(--ink)" opacity=".035"/>
<circle cx="160" cy="116" r="62" fill="var(--ink)" opacity=".03"/>
${corners}
<text x="16" y="24" class="k">${mod.code.toUpperCase()}</text>
<text x="304" y="24" class="k" text-anchor="end">PLATE ${String(index).padStart(2, "0")} / 28</text>
<ellipse cx="160" cy="199" rx="82" ry="8" fill="#000" opacity=".55" filter="url(#soft)"/>
${body}
<text x="16" y="226" class="k2">${code}</text>
<text x="304" y="226" class="k2" text-anchor="end">${esc(title)} · ${esc(mod.name)}</text>
</svg>
`;
}

/* ------------------------------------------------------------------ */
/* 28 张示意图                                                         */
/* ------------------------------------------------------------------ */

const PARTS = {};

/* ===== 1. 相机与成像 ===== */

PARTS["h3-cam-01"] = {
  mod: "cam",
  title: "CAMERA MODULE",
  name: "相机模组",
  note: "光学、传感器与 ISP 的集成体，可整体采购与校准。",
  body: () => [
    // 主壳体
    k.rr(58, 92, 118, 76, 10, "f"),
    // 镜头筒 + 镜片
    k.rr(168, 104, 22, 52, 4, "f"),
    k.c(206, 130, 32, "f"),
    k.c(206, 130, 24, "fi"),
    k.c(206, 130, 14, "fs"),
    k.c(206, 130, 14, "l"),
    k.p("M188 116a24 24 0 0 0 0 28", "t"),
    // 传感器板在壳体里
    k.ln(58, 118, 176, 118, "t"),
    k.ln(58, 142, 176, 142, "t"),
    // 排线
    k.p("M58 152c-14 0-22 8-22 18v6", "l"),
    k.p("M58 160c-9 0-14 6-14 16v6", "l"),
    k.rr(34, 172, 26, 8, 2, "f2"),
    // 四角螺钉
    ...[62, 118].flatMap((y) => [k.c(66, y, 3, "fs"), k.c(166, y, 3, "fs")]),
    k.lead(206, 112, 262, 96, "1/2.3″ · 4K60"),
    k.dimH(58, 176, 84, "38 mm"),
    k.p("M96 168h44v14H96z", "f2"),
    k.t(100, 178, "ISP", "k2"),
  ].join(""),
};

PARTS["h3-cam-02"] = {
  mod: "cam",
  title: "LENS & IR FILTER",
  name: "镜头与滤光片",
  note: "镜片组与 IR 滤光片，决定视场角与进光量。",
  body: () => [
    // 光轴
    k.ln(34, 130, 292, 130, "d"),
    // 镜筒剖面
    k.rr(86, 78, 12, 104, 2, "f"),
    k.rr(198, 88, 11, 84, 2, "f"),
    k.ln(98, 78, 198, 88, "l"),
    k.ln(98, 182, 198, 172, "l"),
    // 三片镜片（双凸剖面）
    ...[118, 150, 178].map((x, i) => {
      const r = [26, 32, 22][i];
      return (
        k.p(`M${x} ${130 - r}Q${x + 17} 130 ${x} ${130 + r}`, "l") +
        k.p(`M${x} ${130 - r}Q${x - 15} 130 ${x} ${130 + r}`, "l") +
        k.ln(x, 130 - r, x, 130 + r, "t")
      );
    }),
    // IR 滤光片（剖面斜线）
    k.rr(212, 96, 8, 68, 1, "f2"),
    k.hatch("ftr", 212, 96, 8, 68, 5),
    // 压圈
    k.rr(226, 92, 12, 76, 2, "f"),
    // 光线示意
    k.p("M40 96 120 130 40 164", "t"),
    k.p("M120 130h72", "t"),
    k.lead(120, 96, 62, 70, "EFL 6.2 mm"),
    k.dimH(86, 238, 200, "Ø 28 mm"),
  ].join(""),
};

PARTS["h3-cam-03"] = {
  mod: "cam",
  title: "IMAGE SENSOR PCB",
  name: "图像传感器板",
  note: "承载 CMOS 与 ISP 的电路板，含图像输出接口。",
  body: () => [
    // 板
    k.rr(56, 86, 192, 92, 5, "f2"),
    // 走线
    ...[0, 1, 2].map((i) => k.p(`M64 ${150 + i * 6}h56v-${8 + i * 9}`, "t")),
    k.p("M248 100h-46v22", "t"),
    k.p("M248 160h-52v-12", "t"),
    // CMOS 封装
    k.rr(118, 100, 76, 62, 3, "f"),
    k.rr(130, 110, 52, 42, 2, "fi"),
    k.rr(138, 118, 36, 26, 1, "fs"),
    k.c(156, 131, 9, "l"),
    // 焊盘环
    k.pads(120, 94, 10, 7, 4, 3),
    k.pads(120, 164, 10, 7, 4, 3),
    // FPC 座
    k.rr(210, 112, 20, 34, 2, "f"),
    k.pads(214, 118, 2, 8, 12, 5),
    // 安装孔
    ...[68, 236].flatMap((x) => [k.c(x, 98, 3.4, "fs"), k.c(x, 166, 3.4, "fs")]),
    k.lead(156, 131, 100, 74, "CMOS 1/2.3″", "end"),
    k.lead(222, 150, 268, 178, "MIPI 4-lane"),
    k.dimH(56, 248, 78, "42 mm"),
  ].join(""),
};

PARTS["h3-cam-04"] = {
  mod: "cam",
  title: "HEAT SPREADER",
  name: "散热支架",
  note: "相机模组的结构支撑兼导热件，抑制长时间录制温升。",
  body: () => [
    // 相机安装面（虚线轮廓 = 相机底面投影）
    k.rr(104, 88, 116, 26, 4, "d"),
    k.t(110, 84, "相机安装面", "k2"),
    // 导热垫（安装面与支架之间）
    k.rr(104, 114, 116, 7, 2, "fi"),
    // 主承力板
    k.rr(88, 121, 148, 13, 3, "f"),
    // 立式安装耳
    k.rr(88, 92, 13, 34, 2, "f2"),
    k.c(94.5, 100, 3.4, "fs"),
    k.c(94.5, 116, 3.4, "fs"),
    k.rr(223, 92, 13, 34, 2, "f2"),
    k.c(229.5, 100, 3.4, "fs"),
    k.c(229.5, 116, 3.4, "fs"),
    // 翅片
    ...Array.from({ length: 9 }, (_, i) => k.ln(104 + i * 14, 134, 104 + i * 14, 170, "l")),
    // 底板
    k.rr(88, 170, 148, 9, 2, "f2"),
    k.c(96, 174.5, 3.4, "fs"),
    k.c(228, 174.5, 3.4, "fs"),
    // 热流
    k.p("M162 76v10", "t"),
    k.p("M158 78l4 5 4-5", "t"),
    k.t(174, 78, "Tj ↓ 12 °C", "k2"),
    k.lead(162, 117, 216, 194, "导热垫 1.5 mm"),
    k.dimH(88, 236, 58, "44 mm"),
    k.dimV(121, 179, 252, "9 mm"),
  ].join(""),
};

/* ===== 2. 俯仰轴总成 ===== */

PARTS["h3-pit-01"] = {
  mod: "pit",
  title: "TILT MOTOR",
  name: "俯仰无刷电机",
  note: "驱动俯仰轴的无刷电机，含霍尔/编码反馈。",
  body: () => [
    // 定子
    k.c(148, 128, 56, "f"),
    k.c(148, 128, 42, "f2"),
    k.ring(148, 128, 42, 9, 11, "f2"),
    k.c(148, 128, 16, "fs"),
    // 转子杯
    k.p("M148 66a62 62 0 0 1 0 124", "l"),
    k.p("M148 74a54 54 0 0 0 0 108", "t"),
    // 轴
    k.rr(204, 121, 46, 14, 3, "f"),
    k.ln(204, 114, 204, 142, "l"),
    k.lead(248, 121, 268, 100, "Ø6 h6"),
    // 三相线
    k.p("M116 176c-8 10-4 18 4 20", "l"),
    k.p("M126 180c-6 10-2 16 6 18", "l"),
    k.p("M136 182c-4 10 0 14 8 16", "l"),
    k.t(96, 208, "U V W", "k2"),
    // 磁钢
    k.ring(148, 128, 50, 12, 2.2, "s"),
    k.dimH(86, 210, 58, "Ø 44 mm"),
  ].join(""),
};

PARTS["h3-pit-02"] = {
  mod: "pit",
  title: "TILT ARM",
  name: "俯仰轴臂",
  note: "连接俯仰电机与相机端的结构臂，决定轴长与刚度。",
  body: () => [
    // 臂身（锥形梁）
    k.poly(
      [
        [78, 112],
        [196, 96],
        [214, 128],
        [196, 160],
        [78, 144],
      ],
      "f",
    ),
    // 端部凸台
    k.c(78, 128, 22, "f2"),
    k.c(78, 128, 9, "fs"),
    k.c(206, 128, 26, "f2"),
    k.c(206, 128, 10, "fs"),
    // 碳纤维纹
    ...Array.from({ length: 5 }, (_, i) => {
      const y = 108 + i * 8;
      return k.p(`M96 ${y}l84-${8}`, "h");
    }),
    // 加强筋
    k.p("M100 118l92-10", "t"),
    k.p("M100 138l92 10", "t"),
    // 减重孔
    k.e(140, 128, 14, 9, "fs"),
    k.lead(78, 106, 44, 84, "Ø14 H7", "end"),
    k.lead(206, 154, 252, 182, "Ø20 轴承位"),
    k.dimH(78, 206, 186, "轴长 62 mm"),
  ].join(""),
};

PARTS["h3-pit-03"] = {
  mod: "pit",
  title: "IMU-A MODULE",
  name: "姿态传感 IMU-A",
  note: "俯仰轴的姿态检测单元，输出角速度与角度。",
  body: () => [
    // 小板
    k.rr(96, 92, 112, 84, 4, "f2"),
    // MEMS 封装
    k.rr(124, 110, 56, 48, 2, "f"),
    k.rr(132, 118, 40, 32, 1, "fi"),
    k.c(152, 134, 7, "l"),
    // 焊盘
    k.pads(128, 104, 7, 7, 4, 3),
    k.pads(128, 162, 7, 7, 4, 3),
    // 器件
    k.rr(102, 100, 14, 10, 1, "fs"),
    k.rr(102, 156, 14, 10, 1, "fs"),
    k.rr(186, 124, 12, 22, 1, "fs"),
    // 三轴坐标系
    k.p("M228 178v-30", "l"),
    k.p("M228 148l-4 7h8z", "s"),
    k.p("M228 178h26", "l"),
    k.p("M254 178l-7-4v8z", "s"),
    k.p("M228 178l-14 14", "l"),
    k.p("M214 192l8 0-4-7z", "s"),
    k.t(232, 146, "Z", "k2"),
    k.t(258, 170, "X", "k2"),
    k.t(206, 200, "Y", "k2"),
    // 标记
    k.t(100, 190, "±0.1°", "k3"),
    k.dimH(96, 208, 84, "24 mm"),
  ].join(""),
};

PARTS["h3-pit-04"] = {
  mod: "pit",
  title: "MINI BEARING",
  name: "微型轴承",
  note: "俯仰轴支承轴承，影响回差与顺滑度。",
  body: () => [
    // 外圈
    k.c(120, 126, 52, "l"),
    k.c(120, 126, 44, "l"),
    // 内圈
    k.c(120, 126, 22, "l"),
    k.c(120, 126, 15, "fs"),
    // 滚珠
    k.ring(120, 126, 33, 9, 6, "f2"),
    // 剖面（右侧剖开）
    k.p("M170 96a52 52 0 0 1 0 60", "t"),
    k.hatch("brg", 168, 96, 10, 60, 5),
    // 尺寸
    k.dimH(68, 172, 196, "Ø12 × Ø21 × 5"),
    k.lead(120, 126, 216, 92, "ABEC-5 · P5"),
    k.t(216, 110, "脂润滑", "k2"),
  ].join(""),
};

/* ===== 3. 横滚轴总成 ===== */

PARTS["h3-rol-01"] = {
  mod: "rol",
  title: "ROLL MOTOR",
  name: "横滚无刷电机",
  note: "驱动横滚轴的无刷电机。",
  body: () => [
    // 法兰
    k.rr(74, 86, 16, 84, 3, "f"),
    ...Array.from({ length: 3 }, (_, i) => k.c(82, 100 + i * 28, 4, "fs")),
    // 机壳
    k.rr(90, 92, 84, 72, 8, "f"),
    k.ln(90, 112, 174, 112, "h"),
    k.ln(90, 144, 174, 144, "h"),
    // 前端盖
    k.rr(174, 98, 14, 60, 3, "f2"),
    // 出轴
    k.rr(188, 121, 52, 14, 3, "f"),
    k.p("M222 121v14", "t"),
    // 编码器
    k.c(214, 128, 16, "f2"),
    k.c(214, 128, 6, "fs"),
    // 线束
    k.p("M132 164c-4 14 2 20 10 22", "l"),
    k.p("M146 164c-2 14 4 18 12 20", "l"),
    k.t(96, 206, "3Φ / 12 V", "k2"),
    k.lead(214, 144, 246, 178, "磁编 14 bit"),
    k.dimH(90, 174, 80, "Ø 34 mm"),
  ].join(""),
};

PARTS["h3-rol-02"] = {
  mod: "rol",
  title: "ROLL ARM",
  name: "横滚轴臂",
  note: "横滚轴与俯仰轴之间的连接臂。",
  body: () => [
    // 弧形臂
    k.p("M84 168A74 74 0 0 1 226 112L214 96A88 88 0 0 0 72 154Z", "f"),
    // 两端凸台
    k.c(74, 158, 18, "f2"),
    k.c(74, 158, 7, "fs"),
    k.c(220, 106, 20, "f2"),
    k.c(220, 106, 8, "fs"),
    // 圆弧尺寸
    k.p("M74 158A76 76 0 0 1 218 108", "d"),
    // 减重窗
    k.rr(118, 132, 46, 14, 6, "fs"),
    k.rr(126, 118, 30, 8, 4, "fs"),
    k.lead(150, 139, 178, 178, "减重窗 2-Φ8"),
    k.lead(220, 126, 256, 150, "Ø22 轴承位"),
    k.t(66, 200, "R76", "k3"),
  ].join(""),
};

PARTS["h3-rol-03"] = {
  mod: "rol",
  title: "SLIP RING",
  name: "滑环线束",
  note: "跨轴旋转导电的滑环与线束，保证连续 360° 供电与信号。",
  body: () => [
    // 外壳剖面
    k.rr(96, 84, 108, 88, 4, "f2"),
    k.ln(96, 84, 96, 172, "l"),
    k.ln(204, 84, 204, 172, "l"),
    // 同心环（剖面）
    ...Array.from({ length: 4 }, (_, i) => k.rr(112 + i * 20, 96, 9, 64, 1, "fi")),
    // 电刷
    ...Array.from({ length: 4 }, (_, i) => k.rr(107 + i * 20, 120, 6, 8, 1, "fs")),
    // 轴
    k.ln(78, 128, 232, 128, "t"),
    k.rr(72, 118, 18, 20, 2, "f"),
    // 线束
    k.p("M204 104c22 0 30 10 30 24", "l"),
    k.p("M204 116c16 2 22 10 22 22", "l"),
    k.p("M204 152c22-2 30-10 30-22", "l"),
    k.lead(160, 96, 150, 62, "4 环 · 2A/环", "end"),
    k.dimH(96, 204, 190, "Ø 22 mm"),
  ].join(""),
};

PARTS["h3-rol-04"] = {
  mod: "rol",
  title: "LIMIT STOP",
  name: "机械限位件",
  note: "限制横滚轴行程的机械挡块，防止线束过扭。",
  body: () => [
    // 底板
    k.rr(74, 158, 172, 18, 3, "f"),
    k.c(86, 167, 4.5, "fs"),
    k.c(234, 167, 4.5, "fs"),
    // 立式挡块（带倒角）
    k.poly(
      [
        [110, 158],
        [110, 104],
        [118, 92],
        [140, 92],
        [148, 104],
        [148, 158],
      ],
      "f2",
    ),
    // 缓冲垫
    k.rr(148, 100, 7, 52, 2, "fi"),
    // 转轴座
    k.c(206, 167, 17, "f"),
    k.c(206, 167, 5.5, "fs"),
    // 限位臂（绕转轴转 -38° 顶到缓冲垫上）
    `<g transform="rotate(-38 206 167)">${k.rr(146, 160.5, 76, 13, 5, "f")}${k.c(152, 167, 6, "fs")}</g>`,
    // 行程弧 + 箭头
    k.p("M162 124A58 58 0 0 1 218 104", "d"),
    k.p("M218 104l-9 1 5 7z", "s"),
    k.t(146, 100, "±45°", "k3"),
    k.lead(128, 122, 92, 96, "挡块 6061", "end"),
    k.lead(176, 136, 216, 202, "缓冲垫 NBR"),
    k.dimH(74, 246, 190, "96 mm"),
  ].join(""),
};

/* ===== 4. 航向轴总成 ===== */

PARTS["h3-yaw-01"] = {
  mod: "yaw",
  title: "PAN MOTOR",
  name: "航向无刷电机",
  note: "驱动航向轴的无刷电机。",
  body: () => [
    // 底座法兰
    k.rr(64, 168, 164, 16, 4, "f"),
    ...Array.from({ length: 4 }, (_, i) => k.c(78 + i * 46, 176, 4, "fs")),
    // 电机本体（立式）
    k.rr(104, 74, 84, 96, 10, "f"),
    k.ln(104, 96, 188, 96, "h"),
    k.ln(104, 128, 188, 128, "h"),
    // 端盖
    k.rr(114, 66, 64, 12, 4, "f2"),
    // 轴（上出）
    k.rr(138, 44, 16, 24, 3, "f"),
    // 定子齿
    ...Array.from({ length: 6 }, (_, i) => k.ln(112, 104 + i * 11, 180, 104 + i * 11, "t")),
    // 线束
    k.p("M188 150c16 4 22 14 22 24", "l"),
    k.t(196, 186, "UVW", "k2"),
    k.lead(160, 74, 214, 46, "24 V · 12 P"),
    k.dimV(74, 170, 60, "H 96"),
  ].join(""),
};

PARTS["h3-yaw-02"] = {
  mod: "yaw",
  title: "PAN ARM",
  name: "航向轴臂",
  note: "航向轴与手柄之间的连接臂。",
  body: () => [
    // 立臂
    k.rr(126, 58, 40, 128, 6, "f"),
    // 顶部抱箍
    k.c(146, 66, 24, "f2"),
    k.c(146, 66, 10, "fs"),
    k.ln(146, 42, 146, 58, "l"),
    // 抱箍螺钉
    k.ln(160, 66, 186, 66, "l"),
    k.c(190, 66, 5, "fs"),
    // 底部法兰
    k.rr(96, 176, 100, 16, 4, "f2"),
    ...Array.from({ length: 3 }, (_, i) => k.c(110 + i * 36, 184, 4, "fs")),
    // 加强肋
    k.p("M126 130l-18 30h18", "t"),
    k.p("M166 130l18 30h-18", "t"),
    // 过线孔
    k.e(146, 120, 9, 13, "fs"),
    k.lead(146, 120, 196, 104, "走线孔 Ø12"),
    k.dimV(58, 192, 76, "134 mm"),
  ].join(""),
};

PARTS["h3-yaw-03"] = {
  mod: "yaw",
  title: "MAGNETIC ENCODER",
  name: "磁性编码器",
  note: "航向角的高精度磁编码反馈元件。",
  body: () => [
    // 磁环
    k.c(126, 124, 46, "l"),
    k.c(126, 124, 32, "f2"),
    k.c(126, 124, 12, "fs"),
    // 磁极分区
    ...Array.from({ length: 12 }, (_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return k.ln(
        126 + Math.cos(a) * 32,
        124 + Math.sin(a) * 32,
        126 + Math.cos(a) * 46,
        124 + Math.sin(a) * 46,
        "t",
      );
    }),
    k.ring(126, 124, 39, 6, 1.6, "s"),
    // 霍尔芯片
    k.rr(196, 108, 26, 32, 2, "f"),
    k.rr(202, 118, 14, 12, 1, "fi"),
    k.pads(198, 140, 4, 6, 4, 3),
    // 气隙
    k.dimH(172, 196, 156, "0.5"),
    k.lead(209, 124, 240, 94, "AS5047"),
    k.t(102, 190, "14 bit · 0.02°", "k3"),
  ].join(""),
};

PARTS["h3-yaw-04"] = {
  mod: "yaw",
  title: "SCREW SET",
  name: "锁紧螺钉组",
  note: "轴系与结构件的锁紧螺钉组合，含防松处理。",
  body: () => {
    // 一颗内六角圆柱头螺钉的侧视：头部（含内六角）+ 螺纹杆 + 倒角端
    const screw = (x, y, len) =>
      [
        k.rr(x, y - 12, 20, 24, 3, "f"),
        k.c(x + 10, y, 6.5, "fs"),
        k.poly(
          [
            [x + 6, y - 3.4],
            [x + 10, y - 7],
            [x + 14, y - 3.4],
            [x + 10, y + 3.4],
            [x + 10, y + 7],
          ],
          "s",
        ),
        k.rr(x + 20, y - 5.5, len, 11, 1, "f2"),
        ...Array.from({ length: Math.floor(len / 5) }, (_, i) =>
          k.ln(x + 23 + i * 5, y + 5.5, x + 26 + i * 5, y - 5.5, "h"),
        ),
        k.poly(
          [
            [x + 20 + len, y - 5.5],
            [x + 26 + len, y],
            [x + 20 + len, y + 5.5],
          ],
          "f2",
        ),
      ].join("");

    return [
      screw(50, 92, 62),
      screw(50, 138, 96),
      screw(50, 182, 40),
      // 垫圈 + 螺母
      k.e(274, 92, 14, 6, "f2"),
      k.c(274, 92, 6.5, "fs"),
      k.poly(
        [
          [262, 156],
          [286, 156],
          [292, 168],
          [286, 180],
          [262, 180],
          [256, 168],
        ],
        "f2",
      ),
      k.c(274, 168, 7, "fs"),
      k.lead(272, 78, 214, 62, "M2.5 螺母", "end"),
      k.t(50, 214, "DIN 912 · A2-70 · 内六角", "k2"),
      k.t(50, 222, "M2.5×6 / M2.5×10 / M3×8", "k2"),
      k.lead(60, 92, 34, 64, "内六角", "start"),
    ].join("");
  },
};

/* ===== 5. 手柄与人机 ===== */

PARTS["h3-hnd-01"] = {
  mod: "hnd",
  title: "FRONT SHELL",
  name: "手柄前壳",
  note: "手柄正面外壳，承载按键与屏幕开孔。",
  body: () => [
    // 壳体轮廓
    k.p(
      "M108 56h104c10 0 18 8 18 18v52c0 12-6 20-14 26-8 6-12 14-12 24v20c0 12-10 22-22 22h-44c-12 0-22-10-22-22v-20c0-10-4-18-12-24-8-6-14-14-14-26V74c0-10 8-18 18-18z",
      "f",
    ),
    // 屏幕开孔
    k.rr(126, 78, 68, 40, 6, "fs"),
    k.rr(130, 82, 60, 32, 4, "fi"),
    // 按键
    k.c(146, 142, 7, "f2"),
    k.c(174, 142, 7, "f2"),
    k.rr(128, 158, 28, 10, 5, "f2"),
    // 摇杆孔
    k.c(186, 163, 9, "fs"),
    // 分模线
    k.p("M100 128h120", "d"),
    // 听筒/指示
    k.rr(140, 60, 40, 4, 2, "fi"),
    k.lead(160, 98, 214, 66, "屏窗 48×28"),
    k.dimV(56, 218, 78, "162 mm"),
  ].join(""),
};

PARTS["h3-hnd-02"] = {
  mod: "hnd",
  title: "REAR SHELL",
  name: "手柄后壳",
  note: "手柄背面外壳，与前后壳合模形成握持腔体。",
  body: () => [
    // 后壳轮廓（略窄）
    k.p(
      "M114 60h92c10 0 18 8 18 18v50c0 12-8 18-16 24-8 6-12 14-12 24v18c0 12-10 22-22 22h-28c-12 0-22-10-22-22v-18c0-10-4-18-12-24-8-6-16-12-16-24V78c0-10 8-18 18-18z",
      "f2",
    ),
    // 握持纹（点阵）
    ...Array.from({ length: 6 }, (_, row) =>
      Array.from({ length: 5 }, (_, col) => k.c(126 + col * 14, 150 + row * 9, 1.6, "s")).join(""),
    ),
    // 扳机
    k.p("M210 108c14 2 20 12 20 24", "l"),
    k.p("M210 118c9 2 12 8 12 16", "l"),
    // 合模面
    k.p("M104 128h114", "d"),
    // 螺钉柱
    ...[72, 96, 196, 214].map((y, i) => k.c(i % 2 ? 208 : 112, y, 5, "l")),
    k.lead(160, 172, 224, 202, "防滑纹区"),
    k.dimH(114, 224, 68, "110 mm"),
  ].join(""),
};

PARTS["h3-hnd-03"] = {
  mod: "hnd",
  title: "GRIP SLEEVE",
  name: "握持胶套",
  note: "包覆手柄的防滑软胶件，改善握持与跌落缓冲。",
  body: () => [
    // 胶套外形（中空）
    k.p(
      "M112 62h96c8 0 14 6 14 14v70c0 14-10 22-18 30-8 8-12 18-12 30v14c0 10-8 18-18 18h-38c-10 0-18-8-18-18v-14c0-12-4-22-12-30-8-8-14-16-14-30V76c0-8 6-14 14-14z",
      "f",
    ),
    // 内壁
    k.p(
      "M120 74h80c4 0 6 2 6 6v64c0 10-6 16-12 22-8 8-16 20-16 34v12c0 4-2 6-6 6h-24c-4 0-6-2-6-6v-12c0-14-8-26-16-34-6-6-12-12-12-22V80c0-4 2-6 6-6z",
      "t",
    ),
    // 防滑颗粒
    ...Array.from({ length: 5 }, (_, row) =>
      Array.from({ length: 4 }, (_, col) => k.c(132 + col * 18, 108 + row * 12, 2, "t")).join(""),
    ),
    // 剖面线 A-A
    k.ln(160, 46, 160, 62, "d"),
    k.ln(160, 214, 160, 230, "d"),
    k.t(164, 44, "A", "k3"),
    k.t(164, 228, "A", "k3"),
    k.lead(226, 104, 258, 84, "邵氏 55A"),
    k.t(232, 128, "2.0 mm", "k2"),
  ].join(""),
};

PARTS["h3-hnd-04"] = {
  mod: "hnd",
  title: "QUICK PLATE",
  name: "快装底座",
  note: "手柄底部的快装接口，兼容三脚架与快装板。",
  body: () => [
    // 底板
    k.poly(
      [
        [70, 150],
        [232, 150],
        [244, 158],
        [244, 176],
        [70, 176],
      ],
      "f",
    ),
    // 燕尾槽
    k.poly(
      [
        [94, 124],
        [216, 124],
        [232, 150],
        [78, 150],
      ],
      "f2",
    ),
    k.poly(
      [
        [112, 132],
        [198, 132],
        [208, 148],
        [102, 148],
      ],
      "fs",
    ),
    // 锁紧扳手
    k.rr(238, 120, 14, 44, 4, "f"),
    k.c(245, 132, 4, "fs"),
    // 1/4 螺孔
    k.c(150, 164, 9, "fs"),
    k.c(150, 164, 4, "l"),
    k.lead(150, 164, 96, 196, "1/4″-20", "end"),
    // 防转销
    k.c(186, 164, 4, "fs"),
    k.dimH(70, 244, 196, "86 mm"),
  ].join(""),
};

/* ===== 6. 控制电子 ===== */

PARTS["h3-ctl-01"] = {
  mod: "ctl",
  title: "MAIN CONTROL PCB",
  name: "主控板",
  note: "整机主控 PCBA，运行增稳算法与系统调度。",
  body: () => [
    // 板框
    k.rr(48, 74, 224, 112, 5, "f2"),
    // 主 SoC
    k.rr(112, 96, 74, 62, 3, "f"),
    k.rr(120, 104, 58, 46, 2, "fi"),
    k.t(149, 131, "SoC", "k2"),
    // DDR
    k.rr(196, 100, 18, 50, 2, "f"),
    k.rr(220, 100, 18, 50, 2, "f"),
    // 电源模块
    k.rr(62, 96, 34, 30, 2, "f"),
    k.c(79, 111, 8, "fi"),
    // 连接器
    k.rr(62, 142, 26, 26, 2, "f"),
    k.pads(66, 148, 3, 7, 5, 5),
    // 走线
    ...Array.from({ length: 4 }, (_, i) => k.p(`M96 ${108 + i * 10}h16`, "t")),
    k.p("M186 120h10v-8h4", "t"),
    // 安装孔
    ...[58, 262].flatMap((x) => [k.c(x, 84, 4, "fs"), k.c(x, 176, 4, "fs")]),
    k.lead(149, 108, 154, 56, "四核 1.2 GHz", "middle"),
    k.dimH(48, 272, 66, "56 mm"),
  ].join(""),
};

PARTS["h3-ctl-02"] = {
  mod: "ctl",
  title: "3-AXIS DRIVER",
  name: "三轴驱动板",
  note: "三路电机驱动与电流采样电路板。",
  body: () => [
    // 板框
    k.rr(52, 80, 216, 100, 5, "f2"),
    // 三路驱动（同构，方便一眼看出"三轴"）
    ...Array.from({ length: 3 }, (_, i) => {
      const x = 68 + i * 66;
      return [
        k.rr(x, 96, 48, 52, 3, "f"),
        k.pads(x + 6, 102, 6, 6, 4, 4),
        k.pads(x + 6, 140, 6, 6, 4, 4),
        k.rr(x + 14, 118, 20, 12, 1, "fi"),
        k.t(x + 24, 162, `M${i + 1}`, "k3", "middle"),
      ].join("");
    }),
    // 相电流采样
    ...Array.from({ length: 3 }, (_, i) => k.rr(72 + i * 66, 168, 14, 8, 1, "fs")),
    // 安装孔
    ...[60, 260].flatMap((x) => [k.c(x, 88, 4, "fs"), k.c(x, 172, 4, "fs")]),
    k.lead(212, 96, 226, 62, "DRV 3×", "end"),
    k.dimH(52, 268, 74, "54 mm"),
  ].join(""),
};

PARTS["h3-ctl-03"] = {
  mod: "ctl",
  title: "JOYSTICK & KEYS",
  name: "摇杆与按键",
  note: "摇杆、按键与相应的人机交互器件组合。",
  body: () => [
    // 摇杆底座
    k.rr(96, 136, 84, 44, 6, "f2"),
    k.c(138, 136, 40, "f"),
    k.c(138, 136, 26, "f2"),
    // 摇杆帽
    k.c(138, 118, 20, "f"),
    k.c(138, 112, 7, "fs"),
    // 十字方向
    k.p("M138 84v-14M138 152v14M104 118h-14M172 118h14", "t"),
    // 按键 ×2
    k.rr(196, 116, 34, 30, 5, "f"),
    k.rr(200, 120, 26, 22, 4, "fi"),
    k.rr(196, 152, 34, 20, 5, "f2"),
    // 排线
    k.p("M96 158h-24v14", "l"),
    k.rr(58, 168, 16, 10, 2, "f2"),
    k.lead(138, 118, 76, 78, "霍尔摇杆", "end"),
    k.lead(213, 131, 248, 100, "IPX 按键"),
    k.dimH(96, 230, 198, "42 mm"),
  ].join(""),
};

PARTS["h3-ctl-04"] = {
  mod: "ctl",
  title: "BLE MODULE",
  name: "蓝牙模块",
  note: "与手机 App 通信的蓝牙模组。",
  body: () => [
    // 模块基板
    k.rr(92, 92, 116, 84, 4, "f2"),
    // 屏蔽罩
    k.rr(104, 104, 62, 60, 3, "f"),
    ...Array.from({ length: 3 }, (_, i) => k.ln(110, 116 + i * 16, 160, 116 + i * 16, "h")),
    k.t(135, 152, "BLE 5.2", "k2"),
    // 天线（蛇形）
    k.p(
      "M174 116h12v28h-14v14h14v10h-14v10h14v14h-12",
      "l",
    ),
    k.lead(174, 116, 226, 88, "板载天线"),
    // 焊盘
    k.pads(100, 168, 8, 12, 8, 4),
    k.dimH(92, 208, 84, "18 mm"),
  ].join(""),
};

/* ===== 7. 电源与线束 ===== */

PARTS["h3-pwr-01"] = {
  mod: "pwr",
  title: "LITHIUM PACK",
  name: "锂电池组",
  note: "整机供电电池组，含电芯与保护板。",
  body: () => [
    // 两节电芯
    k.rr(76, 86, 74, 96, 6, "f"),
    k.rr(160, 86, 74, 96, 6, "f"),
    // 极耳
    k.rr(96, 74, 14, 14, 2, "f2"),
    k.rr(196, 74, 14, 14, 2, "f2"),
    // 保护板
    k.rr(84, 176, 142, 14, 3, "f"),
    k.pads(92, 180, 6, 10, 5, 6),
    // 连线
    k.p("M110 90v-8h80v8", "l"),
    // 电量指示
    k.rr(186, 108, 30, 8, 3, "fs"),
    k.rr(188, 110, 18, 4, 2, "fi"),
    k.t(186, 128, "3/4", "k2"),
    // 引出线
    k.p("M96 190v14h-18", "l"),
    k.p("M214 190v14h18", "l"),
    k.lead(113, 134, 60, 152, "2S 5000 mAh", "end"),
    k.dimH(76, 234, 66, "58 mm"),
  ].join(""),
};

PARTS["h3-pwr-02"] = {
  mod: "pwr",
  title: "POWER MANAGEMENT",
  name: "电源管理板",
  note: "充放电管理、电量计与多路稳压的 PCBA。",
  body: () => [
    // 板框
    k.rr(60, 78, 200, 104, 5, "f2"),
    // 两路电感
    k.c(104, 118, 22, "f"),
    k.c(104, 118, 12, "fi"),
    k.c(186, 118, 22, "f"),
    k.c(186, 118, 12, "fi"),
    // 稳压 IC
    k.rr(136, 100, 24, 18, 2, "f"),
    k.rr(136, 136, 24, 18, 2, "f"),
    // USB-C 焊盘
    k.pads(232, 104, 2, 10, 8, 30),
    // 走线
    ...Array.from({ length: 3 }, (_, i) => k.p(`M${82 + i * 6} 150h${i * 18}`, "t")),
    ...Array.from({ length: 3 }, (_, i) => k.p(`M${200 + i * 6} 96v${i * 8}`, "t")),
    k.lead(104, 118, 66, 168, "Buck ×2", "end"),
    k.lead(200, 96, 236, 74, "USB-PD"),
    k.dimH(60, 260, 70, "48 mm"),
  ].join(""),
};

PARTS["h3-pwr-03"] = {
  mod: "pwr",
  title: "USB-C RECEPTACLE",
  name: "USB-C 接口",
  note: "充电与数据传输的 USB-C 连接器及外围。",
  body: () => [
    // 外壳（正视）
    k.rr(96, 92, 128, 64, 30, "f"),
    k.rr(108, 102, 104, 44, 22, "fs"),
    // 舌片
    k.rr(118, 114, 84, 20, 8, "f2"),
    // 上下排针
    ...Array.from({ length: 12 }, (_, i) => k.c(126 + i * 7, 110, 1.6, "s")),
    ...Array.from({ length: 12 }, (_, i) => k.c(126 + i * 7, 138, 1.6, "s")),
    // 固定脚
    k.p("M104 156v16M216 156v16", "l"),
    k.p("M96 156h16M208 156h16", "t"),
    // 剖面
    k.ln(160, 76, 160, 92, "d"),
    k.lead(160, 124, 254, 96, "24 pin"),
    k.dimH(96, 224, 66, "9.4 mm"),
  ].join(""),
};

PARTS["h3-pwr-04"] = {
  mod: "pwr",
  title: "WIRE HARNESS",
  name: "内部线束",
  note: "连接各板卡与电机的内部线缆组合。",
  body: () => [
    // 三根导线
    k.p("M70 108c40 0 46 20 76 20s40 20 76 20", "l"),
    k.p("M70 126c40 0 46 10 76 10s40 10 76 10", "l"),
    k.p("M70 144c40 0 46 0 76 0s40 0 76 0", "l"),
    // 扎带
    ...[122, 168, 210].map((x) => k.rr(x, 96 + (x - 122) / 6, 6, 46, 2, "f2")),
    // 两端连接器
    k.rr(48, 96, 24, 60, 4, "f"),
    k.pads(52, 102, 3, 18, 16, 12),
    k.rr(228, 96, 24, 60, 4, "f"),
    k.pads(232, 102, 3, 18, 16, 12),
    // 线规
    k.t(126, 190, "AWG 24 / 26", "k2"),
    k.lead(166, 128, 196, 196, "1.0 mm²"),
    k.dimH(48, 252, 76, "32 mm"),
  ].join(""),
};

/* ------------------------------------------------------------------ */
/* 输出                                                                */
/* ------------------------------------------------------------------ */

function build() {
  const codes = Object.keys(PARTS);
  const missing = [];
  for (const mod of Object.values(MODULES)) {
    const parts = codes.filter((code) => PARTS[code].mod === mod.code.split("-")[1]);
    if (parts.length !== 4) missing.push(`${mod.code}: ${parts.length}`);
  }
  if (codes.length !== 28) missing.push(`total: ${codes.length}`);
  if (missing.length) throw new Error(`零件图数量不对：${missing.join(" / ")}`);

  const files = [];
  codes.forEach((code, index) => {
    const part = PARTS[code];
    const mod = MODULES[part.mod];
    const svg = frame({
      code,
      mod,
      index: index + 1,
      title: part.title,
      body: part.body(),
    });
    files.push({ code, mod, part, svg });
  });
  return files;
}

function main() {
  const write = process.argv.includes("--write");
  const files = build();
  const total = files.reduce((sum, file) => sum + Buffer.byteLength(file.svg, "utf8"), 0);

  if (write) {
    mkdirSync(OUT_DIR, { recursive: true });
    for (const file of files) {
      writeFileSync(join(OUT_DIR, `${file.code}.svg`), file.svg, "utf8");
    }
    const manifest = {
      schemaVersion: "atlas.part-art/v1",
      note: "每个零件类型一张示意图（同类 10 个型号共用）。文件名 = 零件类型代码。",
      count: files.length,
      generatedBy: "atlas/scripts/gen-part-art.mjs",
      items: files.map((file, index) => ({
        code: file.code,
        plate: index + 1,
        title: file.part.title,
        name: file.part.name,
        module: file.mod.code,
        moduleName: file.mod.name,
        file: `${file.code}.svg`,
        note: file.part.note,
      })),
    };
    writeFileSync(join(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }

  for (const [index, file] of files.entries()) {
    const kb = (Buffer.byteLength(file.svg, "utf8") / 1024).toFixed(1);
    console.log(
      `${String(index + 1).padStart(2, "0")} ${file.code.padEnd(11)} ${file.mod.code.padEnd(7)} ${file.part.name.padEnd(8)} ${kb} KB`,
    );
  }
  console.log(`\n${files.length} 张 · 合计 ${(total / 1024).toFixed(1)} KB${write ? " · 已写出" : " · 未写出（加 --write）"}`);
}

main();
