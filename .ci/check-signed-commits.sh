#!/bin/sh
# Fail if any commit being pushed is not signed.
#
# prek runs this at the pre-push stage and exports the same variables pre-commit does:
#   PRE_COMMIT_FROM_REF - what the remote already has (all zeros for a brand-new branch)
#   PRE_COMMIT_TO_REF   - what is about to be pushed
# Git passes the push range on stdin, but prek consumes that, so these are the only source of
# truth for the range. Falling back to HEAD alone would verify the entire history.
#
# Why pre-push and not commit-msg: at commit-msg time the commit does not exist yet, so
# `git verify-commit HEAD` there checks the PREVIOUS commit. post-commit sees the right commit,
# but git ignores a post-commit hook's exit code, so it can report and never block.
set -eu

from="${PRE_COMMIT_FROM_REF:-}"
to="${PRE_COMMIT_TO_REF:-HEAD}"

# A new branch has no remote ancestor: git reports an all-zero "from". Verifying $to alone would
# walk the whole history, so restrict to commits that exist on no remote yet.
if [ -z "$from" ] || [ -z "$(printf '%s' "$from" | tr -d '0')" ]; then
	set -- "$to" --not --remotes
else
	set -- "$from..$to"
fi

# %G? is git's signature verdict. G = good, U = good but the key is not marked trusted; both mean
# the commit really is signed, which is what this hook is asserting. Everything else is reported
# with its code, because the useful failures look very different:
#   N = not signed at all                     -> sign it
#   E = signed, but the key is not available   -> import the key (GitHub's web-flow commits land
#       locally                                   here; they are signed, just not by a key you hold)
#   B = bad signature, R = revoked, X/Y = expired
rc=0
for commit in $(git rev-list --no-merges "$@"); do
	verdict=$(git log -1 --format='%G?' "$commit")
	case "$verdict" in
		G | U) ;;
		*)
			if [ "$rc" -eq 0 ]; then
				echo "Refusing to push: commits are not verifiably signed." >&2
				rc=1
			fi
			printf '  [%s] %s\n' "$verdict" "$(git log -1 --format='%h %s' "$commit")" >&2
			;;
	esac
done

if [ "$rc" -ne 0 ]; then
	echo >&2
	echo "  N = unsigned   E = signed but key unavailable locally   B/R/X/Y = bad/revoked/expired" >&2
	echo "  Sign unsigned commits with:  git rebase --exec 'git commit --amend --no-edit -S' $from" >&2
fi

exit "$rc"
