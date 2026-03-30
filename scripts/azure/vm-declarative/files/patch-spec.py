#!/usr/bin/env python3
"""Patch an OpenPalm setup spec YAML with Key Vault secrets.

Usage:
  patch-spec.py <spec-file> <key>=<value> [<key>=<value> ...]

Keys use dotted paths into the YAML structure:
  spec.security.adminToken=secret123
  spec.channelCredentials.slack.slackBotToken=xoxb-...
  spec.channels.slack.enabled=true

Values of 'true'/'false' are coerced to booleans.
"""

import sys
import yaml
from pathlib import Path


def set_nested(obj, dotted_key, value):
    parts = dotted_key.split(".")
    for part in parts[:-1]:
        if part not in obj or not isinstance(obj[part], dict):
            obj[part] = {}
        obj = obj[part]
    if isinstance(value, str):
        if value.lower() == "true":
            value = True
        elif value.lower() == "false":
            value = False
    obj[parts[-1]] = value


def main():
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    spec_path = Path(sys.argv[1])
    doc = yaml.safe_load(spec_path.read_text())

    for arg in sys.argv[2:]:
        key, sep, val = arg.partition("=")
        if not key or not sep:
            print(f"Skipping malformed argument: {arg}", file=sys.stderr)
            continue
        set_nested(doc, key, val)

    spec_path.write_text(yaml.dump(doc, default_flow_style=False, sort_keys=False))


if __name__ == "__main__":
    main()
