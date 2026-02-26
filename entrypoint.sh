#!/bin/bash
# Session container entrypoint.
# If AUTO_CMD is set:
#   1. Run the command inside `script` so terminal output is captured to a file
#   2. A background watcher extracts URLs from that file into /tmp/.auth_urls
#   3. The server can read /tmp/.auth_urls to surface URLs to the UI

if [ -n "$AUTO_CMD" ]; then
  echo "$AUTO_CMD" > /tmp/.auto_cmd

  cat >> /home/node/.bashrc << 'AUTOCMD'
if [ -f /tmp/.auto_cmd ]; then
  __cmd=$(cat /tmp/.auto_cmd)
  rm -f /tmp/.auto_cmd

  # Background URL watcher: extracts URLs from script output every second
  (while true; do
    if [ -f /tmp/.cmd_output ]; then
      # Strip ANSI escape codes, then extract URLs
      sed 's/\x1b\[[0-9;]*[a-zA-Z]//g; s/\x1b\][^\x07]*\x07//g' /tmp/.cmd_output \
        | grep -oE 'https?://[A-Za-z0-9_.~:/?#@!$&()*+,;=%\-]+' \
        | sort -u | head -10 > /tmp/.auth_urls 2>/dev/null
    fi
    sleep 1
  done) &

  # Run command with output capture — user still sees and interacts with it
  script -qf /tmp/.cmd_output -c "$__cmd"
fi
AUTOCMD
fi

exec ttyd -W -p 7681 -t enableClipboard=true bash
