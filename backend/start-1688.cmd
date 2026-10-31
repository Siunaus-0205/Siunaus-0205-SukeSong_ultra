@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  ATLAS Market Watch · 真实 1688 模式启动
rem
rem  和 start.cmd 的区别只有环境变量：这里把平台切到 1688、
rem  关掉模拟 AI、把请求间隔拉到 8 秒、每个类型最多取 2 个商品。
rem  不动 market-config.env，所以随时可以回到 start.cmd 的模拟模式。
rem
rem  前置条件（只做一次）：
rem    node scripts\1688-login.mjs     扫码登录，Cookie 会自动写进 data\1688-cookie.txt
rem    node scripts\check-1688.mjs     看到 ✅ 可以抓取 再启动
rem ============================================================

set "MARKET_PLATFORM=1688"
set "MARKET_AI_MOCK=0"
set "MARKET_1688_DELAY_MS=8000"
set "MARKET_1688_SEARCH_LIMIT=2"
set "MARKET_1688_DIRECT=1"

if not exist "data\1688-cookie.txt" (
  echo [!] 还没登录过 1688：先跑 node scripts\1688-login.mjs 扫码。
  echo     没有 Cookie 也能启动，但详情页很快会被滑块拦截。
  echo.
)

node server.mjs
pause
