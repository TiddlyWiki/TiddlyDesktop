#!/bin/sh
# Install the repo's git hooks into .git/hooks (they can't live there under version control).
# Run once after cloning:  ./bin/install-hooks.sh
set -e
ROOT=$(git rev-parse --show-toplevel)
for hook in "$ROOT"/bin/hooks/*; do
	name=$(basename "$hook")
	cp "$hook" "$ROOT/.git/hooks/$name"
	chmod +x "$ROOT/.git/hooks/$name"
	echo "installed hook: $name"
done
