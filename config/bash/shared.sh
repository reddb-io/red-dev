# Point the tools at the shared configuration directory.
#
# This is the half of "one directory, both environments" that actually
# works. Binaries cannot be shared — ELF and PE are different formats, so
# the most a directory can do is hold both and let each side's PATH pick
# its own. Source code should not be shared: a red-dev build takes 324 ms
# on WSL's own ext4 and 2726 ms across the boundary, and you compile all
# day. Configuration is the case that pays off: small, read once per
# shell, and genuinely identical on both sides.
#
# Measured rather than assumed, on the machine this was written for:
# reading 20 small config files costs 22 ms natively and 65 ms across the
# 9p mount. Forty-three milliseconds per shell, once.
#
# Inert without RED_SHARE, which rc.sh only exports when the directory is
# really there — so nobody who has not opted in pays anything, and a
# stale root does not point every tool below at somewhere that is gone.

[ -n "${RED_SHARE:-}" ] || return 0

_red_share_cfg="$RED_SHARE/config"
[ -d "$_red_share_cfg" ] || return 0

# Each of these was verified by pointing the tool at a config and
# checking that it obeyed, not by reading `--help` — which failed to
# mention three of the four that do support it. Guarded on the file
# existing so a partially-populated share degrades to each tool's own
# default rather than to an error.
[ -r "$_red_share_cfg/starship.toml" ] && export STARSHIP_CONFIG="$_red_share_cfg/starship.toml"
[ -r "$_red_share_cfg/mise.toml" ] && export MISE_CONFIG_FILE="$_red_share_cfg/mise.toml"
[ -d "$_red_share_cfg/zellij" ] && export ZELLIJ_CONFIG_DIR="$_red_share_cfg/zellij"
[ -d "$_red_share_cfg/yazi" ] && export YAZI_CONFIG_HOME="$_red_share_cfg/yazi"
[ -d "$_red_share_cfg/atuin" ] && export ATUIN_CONFIG_DIR="$_red_share_cfg/atuin"
[ -r "$_red_share_cfg/bat.conf" ] && export BAT_CONFIG_PATH="$_red_share_cfg/bat.conf"

# git is deliberately an include rather than GIT_CONFIG_GLOBAL.
#
# Taking over the global config would discard whatever is already in
# ~/.gitconfig, and this machine's has `/usr/bin/gh auth git-credential`
# in it — a path that exists on exactly one of the two sides. An include
# layers the shared half underneath the local one, so per-platform
# settings stay where they belong and are not silently replaced.
if [ -r "$_red_share_cfg/gitconfig" ] && command -v git >/dev/null 2>&1; then
  if ! git config --global --get-all include.path 2>/dev/null | grep -qxF "$_red_share_cfg/gitconfig"; then
    git config --global --add include.path "$_red_share_cfg/gitconfig"
  fi
fi

unset _red_share_cfg
