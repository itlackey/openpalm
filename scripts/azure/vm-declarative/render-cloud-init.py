#!/usr/bin/env python3
"""Render a cloud-init YAML from the standalone files in files/.

Reads a JSON config on stdin (or from --config <path>) and assembles a
complete cloud-init document that:
  - Installs packages
  - Creates the admin user
  - Writes the setup spec (base64), boot config, helper scripts, and
    backup env + cron entry as files on the target VM
  - Runs first-boot.sh via runcmd

This replaces the old __TEMPLATE_*__ approach.  Each script lives in its
own file under files/ and is embedded verbatim — no placeholder substitution
inside scripts.
"""

import argparse
import json
import sys
import yaml
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
FILES_DIR = SCRIPT_DIR / "files"


def build_cloud_init(cfg: dict) -> dict:
    """Return a cloud-init document as a Python dict."""

    admin_user = cfg["admin_username"]

    boot_env_lines = [
        f'ADMIN_USER="{admin_user}"',
        f'OP_VERSION="{cfg["openpalm_version"]}"',
        f'OP_INSTALL_DIR="{cfg["openpalm_install_dir"]}"',
        f'OP_HOME="{cfg["openpalm_home"]}"',
        f'KV_NAME="{cfg["kv_name"]}"',
        f'SETUP_REF="{cfg["setup_ref"]}"',
    ]

    backup_env_lines = [
        f'OPENPALM_ADMIN_USER="{admin_user}"',
        f'OPENPALM_STORAGE_NAME="{cfg["storage_name"]}"',
        f'OPENPALM_BACKUP_SHARE="{cfg["backup_share"]}"',
    ]

    return {
        "package_update": True,
        "package_upgrade": True,
        "packages": [
            "ca-certificates",
            "curl",
            "git",
            "jq",
            "sudo",
            "unzip",
            "bash",
            "openssl",
            "python3",
            "python3-yaml",
            "apt-transport-https",
            "gnupg",
            "lsb-release",
            "cron",
        ],
        "users": [
            "default",
            {
                "name": admin_user,
                "groups": ["sudo"],
                "shell": "/bin/bash",
                "sudo": "ALL=(ALL) NOPASSWD:ALL",
            },
        ],
        "write_files": [
            # Setup spec (base64-encoded)
            {
                "path": "/var/lib/openpalm/setup-spec.b64",
                "permissions": "0600",
                "owner": "root:root",
                "content": cfg["setup_spec_b64"],
            },
            # Boot config (sourced by first-boot.sh)
            {
                "path": "/etc/openpalm/boot.env",
                "permissions": "0600",
                "owner": "root:root",
                "content": "\n".join(boot_env_lines) + "\n",
            },
            # Backup env (sourced by backup.sh via EnvironmentFile or inline)
            {
                "path": "/etc/openpalm/backup.env",
                "permissions": "0600",
                "owner": "root:root",
                "content": "\n".join(backup_env_lines) + "\n",
            },
            # patch-spec.py helper
            {
                "path": "/usr/local/bin/openpalm-patch-spec.py",
                "permissions": "0755",
                "owner": "root:root",
                "content": (FILES_DIR / "patch-spec.py").read_text(),
            },
            # backup.sh — wrapper that sources its env then runs the real logic
            {
                "path": "/usr/local/bin/openpalm-backup.sh",
                "permissions": "0755",
                "owner": "root:root",
                "content": _wrap_with_env_source(
                    "/etc/openpalm/backup.env",
                    (FILES_DIR / "backup.sh").read_text(),
                ),
            },
            # first-boot.sh
            {
                "path": "/usr/local/bin/openpalm-first-boot.sh",
                "permissions": "0755",
                "owner": "root:root",
                "content": (FILES_DIR / "first-boot.sh").read_text(),
            },
        ],
        "runcmd": [["bash", "-lc", "/usr/local/bin/openpalm-first-boot.sh"]],
    }


def _wrap_with_env_source(env_path: str, script: str) -> str:
    """Insert a 'source <env_path>' line after the shebang."""
    lines = script.split("\n")
    # Find the first non-comment, non-empty line after the shebang block
    insert_at = 1
    for i, line in enumerate(lines):
        if i == 0:
            continue  # skip shebang
        if line.startswith("#") or line.strip() == "":
            insert_at = i + 1
            continue
        break
    lines.insert(insert_at, f'source "{env_path}"')
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Render cloud-init YAML")
    parser.add_argument(
        "--config",
        type=Path,
        default=None,
        help="Path to JSON config (default: read from stdin)",
    )
    args = parser.parse_args()

    if args.config:
        cfg = json.loads(args.config.read_text())
    else:
        cfg = json.load(sys.stdin)

    doc = build_cloud_init(cfg)
    print("#cloud-config")
    print(yaml.dump(doc, default_flow_style=False, sort_keys=False))


if __name__ == "__main__":
    main()
