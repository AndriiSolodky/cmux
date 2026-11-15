#!/usr/bin/env bash
# Post a same-tree tier's commit status from the job that tested it, the moment that job ends.
#
#   post_same_tree_status.sh SHA CONTEXT STATE DESCRIPTION TARGET_URL
#
# GH_TOKEN is the workflow token; GH_TOKEN_SPARE (optional) is a cmux-bot App token with statuses:write,
# which has its own rate budget. Exit 0 once GitHub took the status, 1 (with an ::error) when it never did.
#
# SAME_TREE_STATUS_FROM_JOB (2026-11-14, hq#11150): run 43660624788's daemon tests passed and their post got
# HTTP 403 on the workflow token, the repository's shared hourly budget spent by ~750 queued runs. Nothing
# posted `cmux-next daemon tests (same-tree)`, and a re-run of the failed job cannot start until every other
# job in the run ends (a scheme compile queued for over an hour). So this post must land from inside the job:
# a rate-limited workflow token hands over to the spare token at once, and only then does it wait.
set -uo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: $0 SHA CONTEXT STATE DESCRIPTION TARGET_URL" >&2
  exit 2
fi
sha="$1" context="$2" state="$3" description="$4" target_url="$5"
api="${GITHUB_API_URL:-https://api.github.com}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

if ! [[ "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::warning::not a commit: $sha"
  exit 0
fi
case "$state" in success|failure|error|pending) ;; *) echo "::error::not a status state: $state" >&2; exit 2 ;; esac

body="$(python3 -c 'import json,sys; print(json.dumps({"state": sys.argv[1], "context": sys.argv[2], "target_url": sys.argv[3], "description": sys.argv[4][:140]}))' \
  "$state" "$context" "$target_url" "$description")" || { echo "::error::could not encode the $context status"; exit 1; }

tokens=()
[[ -n "${GH_TOKEN:-}" ]] && tokens+=("$GH_TOKEN")
[[ -n "${GH_TOKEN_SPARE:-}" ]] && tokens+=("$GH_TOKEN_SPARE")
if [[ ${#tokens[@]} -eq 0 ]]; then
  echo "::error title=same-tree status not posted::no token to post the $context status on $sha"
  exit 1
fi

tmp="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/same-tree-status.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
out="$tmp/out" hdr="$tmp/hdr"
which=0 tries=0 until=$((SECONDS + ${POST_BUDGET:-240}))
while :; do
  tries=$((tries + 1))
  : > "$out"; : > "$hdr"
  code="$(curl -sS --connect-timeout 10 --max-time 30 -D "$hdr" -o "$out" -w '%{http_code}' \
    -X POST -H "Authorization: Bearer ${tokens[$which]}" -H "Accept: application/vnd.github+json" \
    "$api/repos/$repo/statuses/$sha" -d "$body")" || true
  code="${code:-000}"
  if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
    echo "posted $context = $state on $sha (token $((which + 1)) of ${#tokens[@]}, try $tries)"
    exit 0
  fi
  said="HTTP $code: $(head -c 200 "$out" | tr -s '\r\n\t' '   ' || true)"
  limited=""
  if [[ "$code" == 403 || "$code" == 429 ]] && grep -qiE 'rate limit|^retry-after:|^x-ratelimit-remaining: *0' "$out" "$hdr"; then
    limited=1
    said="$said (rate limited)"
  fi
  # Any refusal on one token moves to the next one at once: the spare has its own budget and its own grants.
  if (( which + 1 < ${#tokens[@]} )); then
    echo "::warning title=same-tree status::token $((which + 1)) could not post $context ($said); trying the spare token"
    which=$((which + 1))
    continue
  fi
  # Every token tried: a rate limit waits as asked (at least LIMIT_GAP, doubling), a 5xx or no answer waits
  # POST_GAP; anything else (a bad token, a missing grant) is final.
  pause=""
  if [[ -n "$limited" ]]; then
    pause="$(grep -iE '^retry-after: *[0-9]+' "$hdr" | head -n1 | tr -dc '0-9' || true)"
    if grep -qiE '^x-ratelimit-remaining: *0' "$hdr"; then
      reset="$(grep -iE '^x-ratelimit-reset: *[0-9]+' "$hdr" | head -n1 | tr -dc '0-9' || true)"
      [[ -z "$reset" ]] || pause=$(( reset - $(date +%s) + 1 ))
    fi
    min=$(( ${LIMIT_GAP:-20} * (1 << (tries > 4 ? 4 : tries - 1)) ))
    if [[ -z "$pause" ]] || (( pause < min )); then pause=$min; fi
  elif [[ "$code" == 000 || "$code" =~ ^5[0-9][0-9]$ ]]; then
    pause="${POST_GAP:-10}"
  fi
  if [[ -z "$pause" ]] || (( SECONDS + pause > until )); then
    echo "::error title=same-tree status not posted::could not post the $context status on $sha after $tries tries ($said); re-run this job to post it"
    exit 1
  fi
  echo "::warning title=same-tree status::could not post $context ($said); posting again in $pause s"
  sleep "$pause"
  which=0
done
