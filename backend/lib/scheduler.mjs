/**
 * 每日 08:00 调度（按配置时区）。
 *
 * 用"每 20 秒检查一次时区时间"的方式，避免手写夏令时换算；
 * 同一天只触发一次，日期记录在 data/state.json。
 */

import { readJson, updateState } from "./store.mjs";

const CHECK_INTERVAL_MS = 20_000;

export function zoneParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const map = {};
  for (const part of parts) map[part.type] = part.value;
  return {
    date: `${map.year}-${map.month}-${map.day}`,
    time: `${map.hour}:${map.minute}`,
    seconds: Number(map.second) || 0,
  };
}

export function startScheduler(config, runDaily) {
  if (!config.scheduleEnabled) {
    console.log("  定时抓取：未启用（MARKET_SCHEDULE_ENABLED=0）");
    return () => {};
  }
  console.log(
    `  定时抓取：每天 ${config.dailyAt}（${config.timeZone}）${config.simulated ? " · 模拟数据源" : ""}`,
  );

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    const state = readJson(config.stateFile, {}) || {};
    const now = zoneParts(new Date(), config.timeZone);
    if (now.time !== config.dailyAt) return;
    if (state.lastScheduledDate === now.date) return;

    running = true;
    updateState(config, { lastScheduledDate: now.date });
    try {
      await runDaily("schedule");
    } catch (error) {
      console.error(`定时抓取失败：${error.message}`);
    } finally {
      running = false;
    }
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
