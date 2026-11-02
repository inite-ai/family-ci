#!/bin/sh
# Mirror the family's CI tools to inite-ai/family-ci, the public copy that
# public repos (auth, billing, brain) can call: GitHub refuses a public
# repo's call to a private repo's reusable workflow. inite-shared is the
# source of truth; family-ci is never edited by hand.
#
#   sh devops/standards/sync-family-ci.sh          from a clean checkout of inite-shared main
#   sh devops/standards/sync-family-ci.sh --dry    show what would change, push nothing
#
# What is mirrored: the reusable workflows (ci, release-gate, verify-deploy,
# deploy-compose), the family and deploy-compose actions, devops/standards and
# the host's Traefik edge file the deploy names (devops/host). Nothing else, and nothing secret lives in them. Calls
# between them are rewritten from inite-shared to family-ci.
set -eu
dry=0; [ "${1:-}" = --dry ] && dry=1
src=$(git rev-parse --show-toplevel)
cd "$src"
sha=$(git rev-parse HEAD)
[ -z "$(git status --porcelain -- .github devops/standards devops/host)" ] || { echo "sync: uncommitted changes in inite-shared; mirror a commit" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
gh repo clone inite-ai/family-ci "$tmp/family-ci" -- -q
dst="$tmp/family-ci"
rm -rf "$dst/.github" "$dst/devops"
mkdir -p "$dst/.github/workflows" "$dst/.github/actions" "$dst/devops"
for wf in ci.yml release-gate.yml verify-deploy.yml deploy-compose.yml; do cp ".github/workflows/$wf" "$dst/.github/workflows/$wf"; done
cp -R .github/actions/family "$dst/.github/actions/family"
cp -R .github/actions/deploy-compose "$dst/.github/actions/deploy-compose"
cp -R devops/standards "$dst/devops/standards"
cp -R devops/host "$dst/devops/host"
find "$dst/.github" -type f -name '*.yml' -exec sed -i.bak 's#inite-ai/inite-shared/\.github/#inite-ai/family-ci/.github/#g' {} \;
find "$dst/.github" -name '*.bak' -delete
cat >"$dst/README.md" <<MD
# family-ci

The INITE family's shared CI tools, public so that public family repos can call them.

**Generated. Do not edit here.** The source is inite-ai/inite-shared (private): the reusable workflows
\`ci.yml\`, \`release-gate.yml\`, \`verify-deploy.yml\`, \`deploy-compose.yml\`, the \`family\` and
\`deploy-compose\` actions, \`devops/standards\` and \`devops/host\`.
\`devops/standards/sync-family-ci.sh\` in inite-shared writes this repo.

Mirrored from inite-shared@$sha.
MD
cd "$dst"
git add -A
if git diff --cached --quiet; then echo "sync: family-ci already matches inite-shared@${sha%"${sha#???????}"}"; exit 0; fi
git diff --cached --stat | tail -3
[ "$dry" = 1 ] && { echo "sync: --dry, nothing pushed"; exit 0; }
git -c user.name="Mikhail Savchenko" commit -q -m "sync from inite-shared@$sha"
git push -q origin HEAD:main
echo "sync: family-ci now mirrors inite-shared@${sha%"${sha#???????}"}"
