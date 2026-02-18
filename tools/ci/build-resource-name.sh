#!/usr/bin/env bash
set -euo pipefail

base="${1:-}"
suffix="${2:-}"
max_len="${3:-63}"

if [ -z "$base" ] || [ -z "$suffix" ]; then
  echo "Usage: build-resource-name.sh <base> <suffix> [max_len]" >&2
  exit 1
fi

suffix_len="${#suffix}"
base_max_len=$((max_len - suffix_len))
if [ "$base_max_len" -lt 1 ]; then
  base_max_len=1
fi

trimmed="$(echo "$base" | cut -c1-"$base_max_len" | sed -E 's/-+$//')"
if [ -z "$trimmed" ]; then
  trimmed="$(echo "preview" | cut -c1-"$base_max_len")"
fi

echo "${trimmed}${suffix}"
