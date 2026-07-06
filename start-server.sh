#!/bin/bash
cd /home/sachin/Desktop/SMDApp
rm -f dev.log
bun run dev > dev.log 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > server.pid
wait $SERVER_PID
