#!/usr/bin/env bash
set -euo pipefail

BUNDLE=${1:?candidate bundle path is required}
CANDIDATE_SHA=${2:?candidate SHA is required}
BASE_SHA=${3:?base SHA is required}

git cat-file -e "${BASE_SHA}^{commit}"
git fetch --quiet "${BUNDLE}" refs/heads/release-candidate

FETCHED_SHA=$(git rev-parse FETCH_HEAD)
if [ "${FETCHED_SHA}" != "${CANDIDATE_SHA}" ]; then
  echo "Candidate bundle resolved to ${FETCHED_SHA}, expected ${CANDIDATE_SHA}" >&2
  exit 1
fi

if [ "$(git rev-parse "${CANDIDATE_SHA}^")" != "${BASE_SHA}" ]; then
  echo "Candidate ${CANDIDATE_SHA} is not directly atop base ${BASE_SHA}" >&2
  exit 1
fi

git checkout --quiet --detach "${CANDIDATE_SHA}"
if [ "$(git rev-parse HEAD)" != "${CANDIDATE_SHA}" ]; then
  echo "Failed to check out candidate ${CANDIDATE_SHA}" >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Candidate checkout is not clean" >&2
  exit 1
fi
