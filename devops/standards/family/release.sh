#!/usr/bin/env bash
# Ship what has piled up on main: a GitHub Release on origin/main's head,
# which is what moves production (the repo's deploy workflow listens for
# `release: published`). The family copy of initeai's scripts/release.sh.
#
#   sh scripts/family.sh release            show what would go out, then ask
#   sh scripts/family.sh release --yes      release without asking
#   sh scripts/family.sh release --dry      only show what would go out
#   sh scripts/family.sh release --watch    after releasing, wait for the deploy
#                                           and its verify job, and say how it ended
#   sh scripts/family.sh release --redeploy run the last release's deploy again:
#                                           its failed jobs if it failed, else all
#
# It will not release:
# - while a deploy is running (production would move twice in a row);
# - a head whose `ci` check is not green (itself, or the PR it was merged from);
# - when main has nothing new, and then it says whether the last deploy failed.
#
# Tags are the day and a counter: v2026.10.29, v2026.10.29.2, ... The notes
# are GitHub's list of merged PRs since the last release.
#
# The deploy workflows come from .inite/standards.json "deploy.workflows"
# (default: deploy.yml).
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
std="node $here/bin/inite-standards.mjs"
yes=0; dry=0; watch=0; redeploy=0
for a in "$@"; do
  case "$a" in
    --yes) yes=1 ;;
    --dry) dry=1 ;;
    --watch) watch=1 ;;
    --redeploy) redeploy=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)

# The services that publish packages (auth, billing, brain) version with
# release-please: its release PR, once merged, publishes the SemVer release
# that deploys. The family rule is the same - a deploy runs on a published
# release, behind the gate - only the tag differs.
if [ -f .github/workflows/release-please.yml ]; then
  echo "$REPO releases through release-please: merge its release PR, and the release it publishes deploys."
  gh pr list --repo "$REPO" --label "autorelease: pending" --json number,title,url -q '.[] | "  #\(.number) \(.title) \(.url)"' 2>/dev/null || true
  exit 0
fi
workflows=$($std deploy-workflows)
first_wf=$(echo "$workflows" | head -1)

git fetch -q origin main --tags
head=$(git rev-parse origin/main)
last=$(gh release list --repo "$REPO" --limit 1 --exclude-drafts --exclude-pre-releases --json tagName -q '.[0].tagName' 2>/dev/null || true)

deploy_of() { # tag workflow -> "id status conclusion"
  gh run list --repo "$REPO" --workflow "$2" --branch "$1" --limit 1 --json databaseId,status,conclusion \
    -q '.[0] | "\(.databaseId) \(.status) \(.conclusion)"' 2>/dev/null || true
}

for wf in $workflows; do
  running=$(gh run list --repo "$REPO" --workflow "$wf" --limit 5 --json headBranch,status \
    -q '[.[] | select(.status != "completed")][0].headBranch // ""' 2>/dev/null || true)
  if [ -n "$running" ] && [ "$dry" = 0 ]; then
    echo "A deploy is running ($wf, $running). Wait for it: gh run list --repo $REPO --workflow $wf --limit 1"
    exit 1
  fi
done

if [ "$redeploy" = 1 ]; then
  [ -n "$last" ] || { echo "No release to deploy again."; exit 1; }
  for wf in $workflows; do
    read -r id _status conclusion <<<"$(deploy_of "$last" "$wf")"
    [ -n "${id:-}" ] || { echo "No $wf run found for $last."; continue; }
    if [ "$conclusion" = "failure" ] || [ "$conclusion" = "cancelled" ]; then
      gh run rerun "$id" --repo "$REPO" --failed
      echo "Running $last's failed $wf jobs again (run $id)."
    else
      gh run rerun "$id" --repo "$REPO"
      echo "Deploying $last again with $wf (run $id)."
    fi
  done
  exit 0
fi

# What production runs: the last release, else the last good deploy.
if [ -n "$last" ]; then
  base=$(git rev-list -n 1 "$last")
  since="$last"
else
  base=$(gh run list --repo "$REPO" --workflow "$first_wf" --status success --limit 1 --json headSha -q '.[0].headSha' 2>/dev/null || true)
  since="the last deploy (${base:0:8})"
fi
if [ -n "$base" ] && [ "$base" = "$head" ]; then
  echo "Nothing new on main since $since."
  if [ -n "$last" ]; then
    read -r _id _status conclusion <<<"$(deploy_of "$last" "$first_wf")"
    if [ "${conclusion:-}" = "failure" ] || [ "${conclusion:-}" = "cancelled" ]; then
      echo "But $last's deploy ended '$conclusion': production may not run it. 'sh scripts/family.sh release --redeploy' runs it again."
      exit 1
    fi
  fi
  exit 0
fi
if [ -n "$base" ] && git cat-file -e "$base" 2>/dev/null; then
  echo "Since $since:"
  git log --oneline --first-parent "$base..$head" | sed -E 's/^[0-9a-f]+ /  /'
else
  echo "Production's commit is unknown here; the release ships main as it is ($(git log -1 --format=%h origin/main))."
fi

# The head must be green: its own `ci` check, or that of the PR it came from.
verdict=$($std ci-verdict "$REPO" "$head" || true)
echo "ci on ${head:0:8}: $verdict"
[ "$dry" = 1 ] && exit 0
case "$verdict" in
  success*) ;;
  *) echo "Not released: main's head has no green ci check. Fix main first."; exit 1 ;;
esac

day="v$(date -u +%Y.%m.%d)"
tag="$day"
n=2
while git rev-parse -q --verify "refs/tags/$tag" >/dev/null || gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; do
  tag="$day.$n"
  n=$((n + 1))
done

if [ "$yes" = 0 ]; then
  read -r -p "Release $tag to production? [y/N] " answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || { echo "Not released."; exit 1; }
fi

gh release create "$tag" --repo "$REPO" --target "$head" --title "$tag" --generate-notes >/dev/null
echo "Released $tag."
for wf in $workflows; do echo "  deploy: gh run list --repo $REPO --workflow $wf --limit 1"; done
[ "$watch" = 1 ] || exit 0

# Wait for each deploy run of the tag to appear, then for it to end.
status=0
for wf in $workflows; do
  id=""
  for _ in $(seq 1 30); do
    read -r id _s _c <<<"$(deploy_of "$tag" "$wf")"
    [ -n "${id:-}" ] && [ "$id" != "null" ] && break
    sleep 10
  done
  if [ -z "${id:-}" ] || [ "$id" = "null" ]; then
    echo "✗ $wf: no run for $tag after 5 minutes (does it listen for release: published?)"
    status=1
    continue
  fi
  # Poll the run itself: `gh run watch` can return before the run is marked
  # completed (v2026.10.29 of initevents read an empty conclusion that way).
  # Every 30 s, at most 90 minutes.
  conclusion=""
  for _ in $(seq 1 180); do
    read -r _id st conclusion <<<"$(gh run view "$id" --repo "$REPO" --json status,conclusion -q '"\(.databaseId // 0) \(.status) \(.conclusion)"' 2>/dev/null || echo "0 unknown ")"
    [ "$st" = completed ] && break
    conclusion=""
    sleep 30
  done
  if [ "$conclusion" = "success" ]; then
    echo "✓ $wf: $tag deployed and verified (run $id)"
  else
    echo "✗ $wf: $tag ended '$conclusion' (run $id): gh run view $id --repo $REPO --log-failed"
    status=1
  fi
done
exit "$status"
