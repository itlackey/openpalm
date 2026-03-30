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

users:
  - default
  - name: __TEMPLATE_ADMIN_USERNAME__
    groups: [sudo]
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL

write_files:
  - path: /var/lib/openpalm/setup-spec.b64
    permissions: '0600'
    owner: root:root
    encoding: text/plain
    content: __TEMPLATE_SETUP_SPEC_B64__

  - path: /usr/local/bin/openpalm-first-boot.sh
    permissions: '0755'
    owner: root:root
    content: |
      #!/usr/bin/env bash
      set -euo pipefail
      exec > >(tee -a /var/log/openpalm-bootstrap.log) 2>&1
      echo "[openpalm] bootstrap started at $(date -u)"

      ADMIN_USER="__TEMPLATE_ADMIN_USERNAME__"
      OP_VERSION="__TEMPLATE_OPENPALM_VERSION__"
      OP_INSTALL_DIR="__TEMPLATE_OPENPALM_INSTALL_DIR__"
      OP_HOME="__TEMPLATE_OPENPALM_HOME__"
      SETUP_FILE="/var/lib/openpalm/setup-spec.yaml"

      # ── Wait for dpkg/apt locks (cloud-init may still be installing packages) ──
      echo "[openpalm] waiting for apt/dpkg lock release"
      for _ in $(seq 1 60); do
        if ! fuser /var/lib/dpkg/lock /var/lib/apt/lists/lock /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then
          break
        fi
        sleep 3
      done

      # ── Install Docker Engine ──────────────────────────────────────────────
      echo "[openpalm] installing Docker Engine"
      curl -fsSL https://get.docker.com | sh
      systemctl enable docker
      systemctl start docker
      usermod -aG docker "$ADMIN_USER"

      # Wait for Docker daemon to be responsive
      echo "[openpalm] waiting for Docker daemon"
      for _ in $(seq 1 30); do
        if docker info >/dev/null 2>&1; then
          break
        fi
        sleep 2
      done
      docker info >/dev/null 2>&1 || { echo "[openpalm] ERROR: Docker daemon not ready after 60s"; exit 1; }
      echo "[openpalm] Docker is ready"

      # ── Decode the setup spec from base64 ──────────────────────────────────
      mkdir -p /var/lib/openpalm
      base64 -d /var/lib/openpalm/setup-spec.b64 > "$SETUP_FILE"
      rm -f /var/lib/openpalm/setup-spec.b64
      chown "$ADMIN_USER":"$ADMIN_USER" /var/lib/openpalm
      chown "$ADMIN_USER":"$ADMIN_USER" "$SETUP_FILE"
      chmod 600 "$SETUP_FILE"

      # ── Install OpenPalm CLI ───────────────────────────────────────────────
      mkdir -p "$OP_INSTALL_DIR"
      chown -R "$ADMIN_USER":"$ADMIN_USER" "$(dirname "$OP_INSTALL_DIR")"

      echo "[openpalm] installing OpenPalm CLI ${OP_VERSION} and applying setup spec"
      sudo -u "$ADMIN_USER" -H env \
        OP_INSTALL_DIR="$OP_INSTALL_DIR" \
        OP_HOME="$OP_HOME" \
        bash -c "curl -fsSL https://raw.githubusercontent.com/itlackey/openpalm/main/scripts/setup.sh | bash -s -- --version ${OP_VERSION} --force --no-open --file ${SETUP_FILE}"

      echo "[openpalm] bootstrap complete at $(date -u)"

runcmd:
  - [bash, -lc, '/usr/local/bin/openpalm-first-boot.sh']
