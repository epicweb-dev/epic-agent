#!/usr/bin/env bash
set -euo pipefail
APP_NAME="epic-agent"

if [ "$EVENT_NAME" = "pull_request" ]; then
  PREVIEW_KIND="pr"
  PREVIEW_ID="$PR_NUMBER"
else
  PREVIEW_KIND="$INPUT_TARGET"
  PREVIEW_ID=""
  if [ "$PREVIEW_KIND" = "pr" ]; then
    PREVIEW_ID="$INPUT_PR_NUMBER"
    if [ -z "$PREVIEW_ID" ]; then
      echo "inputs.pr_number is required when inputs.target=pr" >&2
      exit 1
    fi
  else
    PREVIEW_ID="$INPUT_PREVIEW_NAME"
    if [ -z "$PREVIEW_ID" ]; then
      PREVIEW_ID="$REF_NAME"
    fi
  fi
fi

# Cloudflare Worker names must be URL-safe; normalize to lower-kebab-case.
slug="$(echo "$PREVIEW_ID" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g' | cut -c1-32 | sed 's/-*$//')"
if [ -z "$slug" ]; then
  slug="preview"
fi

if [ "$PREVIEW_KIND" = "pr" ]; then
  APP_WORKER_NAME="${APP_NAME}-pr-${slug}"
else
  APP_WORKER_NAME="${APP_NAME}-branch-${slug}"
fi

echo "preview_kind=$PREVIEW_KIND" >> "$GITHUB_OUTPUT"
echo "preview_id=$PREVIEW_ID" >> "$GITHUB_OUTPUT"
echo "worker_name=$APP_WORKER_NAME" >> "$GITHUB_OUTPUT"
