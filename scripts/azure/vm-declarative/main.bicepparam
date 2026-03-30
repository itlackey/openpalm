using './main.bicep'

// ── Required (must be customized per deployment) ────────────────────────

// Key Vault and Storage Account names must be globally unique.
// Replace these with your own values.
param keyVaultName = 'kv-openpalm-vm'
param storageAccountName = 'stopenpalm'

// SSH public key — required by Azure for VM creation.
// The NSG blocks all inbound SSH; access is via `az ssh vm` (Entra ID).
// The deploy script injects this value at deployment time.
param sshPublicKey = '__SSH_PUBLIC_KEY__'

// Cloud-init custom data — injected by deploy.sh at deployment time.
param customData = '__CUSTOM_DATA__'

// ── Optional overrides (defaults are usually fine) ──────────────────────

param prefix = 'openpalm'
param vmSize = 'Standard_B1ms'
param osDiskSizeGB = 64
param adminUsername = 'openpalm'
param backupShareName = 'openpalm-backups'
param backupShareQuota = 50
param vnetAddressPrefix = '10.0.0.0/16'
param subnetPrefix = '10.0.1.0/24'
param guardianPort = 3899
