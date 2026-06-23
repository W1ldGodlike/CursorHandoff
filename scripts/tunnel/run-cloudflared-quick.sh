#!/usr/bin/env bash
# Cloudflare quick tunnel helper (macOS / Linux). Mirrors run-cloudflared-quick.ps1.
set -euo pipefail

Port=3000
Action=start
DataDir=''

while [[ $# -gt 0 ]]; do
  case "$1" in
    -Port|--port|-port) Port="$2"; shift 2 ;;
    -Action|--action|-action) Action="$2"; shift 2 ;;
    -DataDir|--data-dir|-datadir) DataDir="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

resolve_data_dir() {
  if [[ -n "$DataDir" ]]; then
    cd "$DataDir" && pwd
    return
  fi
  if [[ -n "${DATA_DIR:-}" ]]; then
    cd "$DATA_DIR" && pwd
    return
  fi
  local repo
  repo="$(cd "$(dirname "$0")/../.." && pwd)"
  echo "$repo/data"
}

pid_path() { echo "$1/cloudflared-quick.pid"; }
log_path() { echo "$1/cloudflared-quick.log"; }
url_path() { echo "$1/web-tunnel-url.json"; }

process_alive() {
  local pid="$1"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

find_cloudflared() {
  if command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
    return 0
  fi
  local candidates=(
    "$HOME/.local/bin/cloudflared"
    /opt/homebrew/bin/cloudflared
    /usr/local/bin/cloudflared
    /usr/bin/cloudflared
  )
  local p
  for p in "${candidates[@]}"; do
    if [[ -x "$p" ]]; then
      echo "$p"
      return 0
    fi
  done
  return 1
}

parse_url() {
  if [[ "$1" =~ (https://[a-z0-9-]+\.trycloudflare\.com) ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

write_web_tunnel_url() {
  local dir="$1" url="$2" path
  path="$(url_path "$dir")"
  node -e "
    const fs=require('fs');
    const p=process.argv[1];
    const url=process.argv[2];
    try {
      if (JSON.parse(fs.readFileSync(p,'utf8')).url===url) process.exit(1);
    } catch {}
    fs.writeFileSync(p, JSON.stringify({ url, updatedAt: new Date().toISOString() }));
  " "$path" "$url"
}

read_saved_tunnel_url() {
  local dir="$1" path
  path="$(url_path "$dir")"
  [[ -f "$path" ]] || return 1
  node -e "try{console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).url||'')}catch{}" "$path" 2>/dev/null || true
}

read_latest_url_from_log() {
  local dir="$1" log line url last=""
  log="$(log_path "$dir")"
  [[ -f "$log" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    url="$(parse_url "$line" || true)"
    [[ -n "$url" ]] && last="$url"
  done < "$log"
  [[ -n "$last" ]] && echo "$last"
}

tunnel_live() {
  local url="$1" health
  [[ -n "$url" ]] || return 1
  health="${url%/}/health"
  curl -sf --max-time 8 "$health" >/dev/null 2>&1
}

poll_log_for_url() {
  local dir="$1" timeout="${2:-90}" deadline url
  deadline=$((SECONDS + timeout))
  while [[ $SECONDS -lt $deadline ]]; do
    url="$(read_latest_url_from_log "$dir" || true)"
    if [[ -n "$url" ]]; then
      write_web_tunnel_url "$dir" "$url" >/dev/null || true
      echo "$url"
      return 0
    fi
    sleep 2
  done
  return 1
}

start_tunnel() {
  local dir="$1" pidfile oldpid saved exe log args proc
  mkdir -p "$dir"
  pidfile="$(pid_path "$dir")"

  if [[ -f "$pidfile" ]]; then
    oldpid="$(tr -d '[:space:]' < "$pidfile")"
    if process_alive "$oldpid"; then
      saved="$(read_saved_tunnel_url "$dir" || true)"
      if [[ -n "$saved" ]] && tunnel_live "$saved"; then
        echo "cloudflared quick tunnel already running (pid=$oldpid)"
        return 0
      fi
      echo "cloudflared pid=$oldpid alive but tunnel dead - restarting"
      kill "$oldpid" 2>/dev/null || true
      rm -f "$pidfile"
    else
      rm -f "$pidfile"
    fi
  fi

  if ! exe="$(find_cloudflared)"; then
    local msg='cloudflared not found (install: brew install cloudflared, or Handoff settings → Install cloudflared)'
    echo "$msg" >> "$(log_path "$dir")"
    echo "$msg" >&2
    return 1
  fi

  log="$(log_path "$dir")"
  : > "$log"
  "$exe" tunnel --url "http://127.0.0.1:$Port" >>"$log" 2>&1 &
  proc=$!
  echo "$proc" > "$pidfile"

  if url="$(poll_log_for_url "$dir" 90)"; then
    echo "cloudflared quick tunnel: $url (pid=$proc)"
    return 0
  fi

  echo "cloudflared started (pid=$proc) but URL not found yet - check $log"
  return 0
}

stop_tunnel() {
  local dir="$1" pidfile process_id
  pidfile="$(pid_path "$dir")"
  if [[ ! -f "$pidfile" ]]; then
    echo 'cloudflared quick tunnel not running'
    return 0
  fi
  process_id="$(tr -d '[:space:]' < "$pidfile")"
  if process_alive "$process_id"; then
    kill "$process_id" 2>/dev/null || true
    echo "stopped cloudflared (pid=$process_id)"
  fi
  rm -f "$pidfile"
  return 0
}

ensure_tunnel() {
  local dir="$1" saved pidfile process_id pid_alive
  saved="$(read_saved_tunnel_url "$dir" || true)"
  pidfile="$(pid_path "$dir")"
  pid_alive=false
  if [[ -f "$pidfile" ]]; then
    process_id="$(tr -d '[:space:]' < "$pidfile")"
    if process_alive "$process_id"; then pid_alive=true; fi
  fi
  if [[ "$pid_alive" == true && -n "$saved" ]] && tunnel_live "$saved"; then
    echo "cloudflared ensure: ok ($saved)"
    return 0
  fi
  echo "cloudflared ensure: restart (pidAlive=$pid_alive)"
  stop_tunnel "$dir"
  sleep 1
  start_tunnel "$dir"
}

show_status() {
  local dir="$1" pidfile running=false process_id=0 url path log
  pidfile="$(pid_path "$dir")"
  if [[ -f "$pidfile" ]]; then
    process_id="$(tr -d '[:space:]' < "$pidfile")"
    if process_alive "$process_id"; then running=true; fi
  fi
  url="$(read_saved_tunnel_url "$dir" || true)"
  echo "running=$running pid=$process_id url=$url"
  log="$(log_path "$dir")"
  if [[ -f "$log" ]]; then
    echo '--- log tail ---'
    tail -n 8 "$log" 2>/dev/null || true
  fi
  return 0
}

data_dir="$(resolve_data_dir)"

case "$Action" in
  start) start_tunnel "$data_dir" ;;
  stop) stop_tunnel "$data_dir" ;;
  status) show_status "$data_dir" ;;
  restart)
    stop_tunnel "$data_dir"
    sleep 1
    start_tunnel "$data_dir"
    ;;
  ensure) ensure_tunnel "$data_dir" ;;
  *) echo "Unknown action: $Action" >&2; exit 2 ;;
esac
