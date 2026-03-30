#cloud-config
package_update: true
package_upgrade: true
packages:
  - ca-certificates
  - curl
  - git
  - jq
  - sudo
  - unzip
  - bash
  - openssl
  - python3
  - python3-yaml

users:
  - default
  - name: __TEMPLATE_ADMIN_USERNAME__
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - __TEMPLATE_SSH_PUBLIC_KEY__

write_files:
  - path: /usr/local/bin/openpalm-first-boot.sh
    permissions: '0755'
    owner: root:root
    content: |
      #!/usr/bin/env bash
      set -euo pipefail
      exec > >(tee -a /var/log/openpalm-bootstrap.log) 2>&1

      ADMIN_USER="__TEMPLATE_ADMIN_USERNAME__"
      OP_VERSION="__TEMPLATE_OPENPALM_VERSION__"
      OP_INSTALL_DIR="__TEMPLATE_OPENPALM_INSTALL_DIR__"
      OP_HOME="__TEMPLATE_OPENPALM_HOME__"
      SETUP_FILE="/var/lib/openpalm/setup-spec.yaml"

      echo "[openpalm] waiting for apt/dpkg lock release"
      while fuser /var/lib/dpkg/lock >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
        sleep 2
      done

      echo "[openpalm] installing Docker Engine"
      curl -fsSL https://get.docker.com | sh
      usermod -aG docker "$ADMIN_USER"

      mkdir -p /var/lib/openpalm
      chown -R "$ADMIN_USER":"$ADMIN_USER" /var/lib/openpalm

      cat <<'SPECEOF' | base64 -d > "$SETUP_FILE"
      __TEMPLATE_SETUP_SPEC_B64__
      SPECEOF
      chown "$ADMIN_USER":"$ADMIN_USER" "$SETUP_FILE"
      chmod 600 "$SETUP_FILE"

      mkdir -p "$OP_INSTALL_DIR"
      chown -R "$ADMIN_USER":"$ADMIN_USER" "$(dirname "$OP_INSTALL_DIR")"

      echo "[openpalm] installing OpenPalm CLI and applying setup spec"
      sudo -u "$ADMIN_USER" -H env \
        OP_INSTALL_DIR="$OP_INSTALL_DIR" \
        OP_HOME="$OP_HOME" \
        bash -lc 'curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/release/0.10.0/scripts/setup.sh | bash -s -- --version "'"$OP_VERSION"'" --force --no-open --file "'"$SETUP_FILE"'"'

      echo "[openpalm] bootstrap complete"

runcmd:
  - [ bash, -lc, '/usr/local/bin/openpalm-first-boot.sh' ]
