#!/bin/bash
# 只读：浏览器后端状态和遗留进程
echo -n "playwright-mcp 8931: "; lsof -nP -iTCP:8931 -sTCP:LISTEN >/dev/null 2>&1 && echo up || echo down
echo "== headless chrome (主进程)"
ps -Ao pid,ppid,etime,command | grep -E 'Google Chrome --headless|chrome-headless|ms-playwright' | grep -v -e grep -e 'type=' | cut -c1-160
echo "== chrome-devtools-mcp / autoConnect（应为空，或只属于其他工具）"
ps -Ao pid,ppid,etime,command | grep -E 'chrome-devtools-mcp|autoConnect' | grep -v grep | cut -c1-160
