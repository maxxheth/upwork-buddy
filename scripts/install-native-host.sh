#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.upworkbuddy.host"
FIREFOX_EXT_ID="upwork-buddy@example.com"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINARY_PATH="${REPO_ROOT}/dist/upwork-buddy-native-host"
EXTENSION_ID=""
BROWSER="chrome"
DRY_RUN="false"

usage() {
  cat <<EOF
Usage: $(basename "$0") --extension-id <ID> [--binary <PATH>] [--browser <chrome|chromium|brave|firefox|all>] [--dry-run]

Installs the Upwork Buddy Native Messaging Host manifest for Chrome/Chromium/Brave/Firefox.
Use --dry-run to preview target paths and generated JSON without writing files.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id)
      EXTENSION_ID="${2:-}"
      shift 2
      ;;
    --binary)
      BINARY_PATH="${2:-}"
      shift 2
      ;;
    --browser)
      BROWSER="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "${BROWSER}" != "firefox" && -z "${EXTENSION_ID}" ]]; then
  echo "Error: --extension-id is required for Chromium-based browsers" >&2
  usage >&2
  exit 2
fi

if [[ "${BINARY_PATH}" != /* ]]; then
  BINARY_PATH="${REPO_ROOT}/${BINARY_PATH#./}"
fi

CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"

chrome_manifest() {
  cat <<JSON
{
  "name": "${HOST_NAME}",
  "description": "Upwork Buddy Local Daemon & MCP Native Messaging Host",
  "path": "${BINARY_PATH}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
JSON
}

firefox_manifest() {
  cat <<JSON
{
  "name": "${HOST_NAME}",
  "description": "Upwork Buddy Local Daemon & MCP Native Messaging Host",
  "path": "${BINARY_PATH}",
  "type": "stdio",
  "allowed_extensions": [
    "${FIREFOX_EXT_ID}"
  ]
}
JSON
}

install_target() {
  local target_dir="$1"
  local content="$2"
  local target_file="${target_dir}/${HOST_NAME}.json"

  if [[ "${DRY_RUN}" == "true" ]]; then
    echo "[dry-run] Would write ${target_file}:"
    printf '%s\n' "${content}"
    return 0
  fi

  mkdir -p "${target_dir}"
  printf '%s\n' "${content}" > "${target_file}"
  chmod 0644 "${target_file}"
  echo "Installed ${target_file}"
}

case "${BROWSER}" in
  chrome)
    install_target "${CONFIG_HOME}/google-chrome/NativeMessagingHosts" "$(chrome_manifest)"
    ;;
  chromium)
    install_target "${CONFIG_HOME}/chromium/NativeMessagingHosts" "$(chrome_manifest)"
    ;;
  brave)
    install_target "${CONFIG_HOME}/BraveSoftware/Brave-Browser/NativeMessagingHosts" "$(chrome_manifest)"
    ;;
  firefox)
    install_target "${HOME}/.mozilla/native-messaging-hosts" "$(firefox_manifest)"
    ;;
  all)
    install_target "${CONFIG_HOME}/google-chrome/NativeMessagingHosts" "$(chrome_manifest)"
    install_target "${CONFIG_HOME}/chromium/NativeMessagingHosts" "$(chrome_manifest)"
    install_target "${CONFIG_HOME}/BraveSoftware/Brave-Browser/NativeMessagingHosts" "$(chrome_manifest)"
    install_target "${HOME}/.mozilla/native-messaging-hosts" "$(firefox_manifest)"
    ;;
  *)
    echo "Error: unsupported --browser '${BROWSER}' (expected chrome|chromium|brave|firefox|all)" >&2
    exit 2
    ;;
esac
