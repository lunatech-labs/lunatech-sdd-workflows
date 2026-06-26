#!/usr/bin/env bash
# install.sh: copy spec-swarm where you want it.
#
#   usage:  install.sh [target]
#     target (optional, otherwise you are asked):
#       global    install for every Claude Code session on this machine
#                 -> ~/.claude/skills/spec-swarm   (invoke as /spec-swarm:sdd)
#       project   install into one repo only
#                 -> <repo>/.claude/               (invoke as /sdd)
#
#   examples:
#     bin/install.sh                 # interactive menu (good for non-tech users)
#     bin/install.sh global          # global, no prompts
#     bin/install.sh project         # project, into the current directory
#     bin/install.sh project ~/code/my-app   # project, into a chosen repo
#
# Re-running is safe: it overwrites the spec-swarm files and leaves anything
# else in those directories alone.
set -euo pipefail

# This script lives in <plugin>/bin/, so the plugin root is one level up.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# The three installable pieces. Bail early if the source looks wrong, so we
# never half-install from a broken checkout.
for d in agents commands skills; do
  if [ ! -d "$PLUGIN_DIR/$d" ]; then
    echo "error: '$PLUGIN_DIR/$d' is missing. Run this from a complete" >&2
    echo "       spec-swarm checkout (the script must stay in its bin/ folder)." >&2
    exit 1
  fi
done

TARGET="${1:-}"
PROJECT_ARG="${2:-}"

# Ask interactively when no target was given on the command line.
if [ -z "$TARGET" ]; then
  echo "Where do you want to install spec-swarm?"
  echo
  echo "  1) Global   every Claude Code session on this machine"
  echo "              invoke it as  /spec-swarm:sdd"
  echo "  2) Project  one repository only"
  echo "              invoke it as  /sdd"
  echo
  printf "Choose 1 or 2: "
  read -r choice
  case "$choice" in
    1) TARGET="global" ;;
    2) TARGET="project" ;;
    *) echo "Not 1 or 2; nothing installed." >&2; exit 1 ;;
  esac
fi

case "$TARGET" in
  global)
    DEST="$HOME/.claude/skills"
    mkdir -p "$DEST"
    # Global install is a plugin-style skill: the whole folder under
    # ~/.claude/skills/spec-swarm. The skill loads its own agents/commands.
    rm -rf "$DEST/spec-swarm"
    cp -R "$PLUGIN_DIR" "$DEST/spec-swarm"
    find "$DEST/spec-swarm" -name .DS_Store -delete   # drop macOS junk
    echo "Installed globally -> $DEST/spec-swarm"
    echo "In any session, run:  /spec-swarm:sdd <what you want to build>"
    ;;

  project)
    # Resolve the target repo: explicit arg, else the current directory.
    REPO="${PROJECT_ARG:-$(pwd)}"
    if [ ! -d "$REPO" ]; then
      echo "error: '$REPO' is not a directory." >&2
      exit 1
    fi
    REPO="$(cd "$REPO" && pwd)"
    CLAUDE_DIR="$REPO/.claude"

    # Project install splits the three pieces into the repo's .claude/, which
    # makes it un-namespaced: invoke as /sdd rather than /spec-swarm:sdd.
    #
    #   agents/   -> flat .md files in .claude/agents/   (sdd-planner.md, etc.)
    #   commands/ -> flat .md files in .claude/commands/ (sdd.md)
    #   skills/   -> the spec-swarm/ subtree in .claude/skills/spec-swarm/
    #
    # Each copy targets only spec-swarm's own files, leaving any other agents,
    # commands, or skills already in the repo untouched.
    mkdir -p "$CLAUDE_DIR/agents" "$CLAUDE_DIR/commands" "$CLAUDE_DIR/skills"
    cp "$PLUGIN_DIR"/agents/*.md   "$CLAUDE_DIR/agents/"
    cp "$PLUGIN_DIR"/commands/*.md "$CLAUDE_DIR/commands/"
    rm -rf "$CLAUDE_DIR/skills/spec-swarm"
    cp -R "$PLUGIN_DIR/skills/spec-swarm" "$CLAUDE_DIR/skills/spec-swarm"
    find "$CLAUDE_DIR/skills/spec-swarm" -name .DS_Store -delete   # drop macOS junk

    echo "Installed into -> $CLAUDE_DIR"
    echo "From a session started in $REPO, run:  /sdd <what you want to build>"
    ;;

  *)
    echo "error: unknown target '$TARGET' (use 'global' or 'project')." >&2
    exit 1
    ;;
esac
