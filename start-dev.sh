#!/bin/bash
cd /home/z/my-project
while true; do
  rm -f dev.log
  node ./node_modules/.bin/next dev -p 3000 > dev.log 2>&1
  echo "Server died, restarting in 2s..." >> dev.log
  sleep 2
done
